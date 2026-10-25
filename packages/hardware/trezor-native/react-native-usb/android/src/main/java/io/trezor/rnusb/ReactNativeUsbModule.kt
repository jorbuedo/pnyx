package io.trezor.rnusb

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

import android.content.Context
import android.content.Intent
import android.app.PendingIntent
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbManager
import android.hardware.usb.UsbRequest
import android.util.Log
import expo.modules.kotlin.exception.Exceptions
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.core.errors.ModuleDestroyedException
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap

// Convert Android USBDevice to JS compatible WebUSBDevice
typealias WebUSBDevice = Map<String, Any?>

const val ACTION_USB_PERMISSION = "io.trezor.rnusb.USB_PERMISSION"
const val ON_DEVICE_CONNECT_EVENT_NAME = "onDeviceConnect"
const val ON_DEVICE_DISCONNECT_EVENT_NAME = "onDeviceDisconnect"
const val LOG_TAG = "ReactNativeUsb"

const val INTERFACE_INDEX = 0
const val CHUNK_SIZE = 64

// Protocol v1 constants
const val PROTOCOL_V1_MAGIC_BYTE: Byte = 0x3F // '?' character - first byte of v1 messages and chunk header

// Protocol v2 (THP) constants
const val THP_CONTINUATION_PACKET: Byte = 0x80.toByte() // Continuation packet marker for THP
const val THP_HEADER_SIZE = 3 // control_byte + 2 bytes channel

/**
 * Trezor VID/PID pairs — mirrors TREZOR_USB_DESCRIPTORS in
 * trezor-protocol/constants.ts (T1 HID, WebUSB bootloader, T2/Safe WebUSB).
 *
 * Only used to scope the *unprompted* permission requests: the attach broadcast
 * and the foreground sweep fire for whatever is on the bus, so without this a
 * plugged hub, dock or phone would pop "allow USB access?" on app launch. An
 * explicit requestPermission() call from JS is not filtered — the caller chose
 * that device.
 */
val TREZOR_USB_IDS = setOf(
    0x534c to 0x0001,
    0x1209 to 0x53c0,
    0x1209 to 0x53c1,
)

class ReactNativeUsbModule : Module() {
    private val moduleCoroutineScope = CoroutineScope(Dispatchers.IO)
    private var isAppInForeground = false
    private var isInPriorityMode = false

    private var devicesRequestedPermissions = mutableListOf<String>()

    private val permissionIntent by lazy {
        val intent = Intent(context, ReactNativeUsbPermissionReceiver::class.java)
        intent.setAction(ACTION_USB_PERMISSION)
        PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_MUTABLE)
    }

    override fun definition() = ModuleDefinition {
        Name("ReactNativeUsb")

        Events(ON_DEVICE_CONNECT_EVENT_NAME, ON_DEVICE_DISCONNECT_EVENT_NAME)

        Function("setPriorityMode") { priorityMode: Boolean ->
            isInPriorityMode = priorityMode
        }

        AsyncFunction("getDevices") {
            return@AsyncFunction getDevices()
        }

        // Every attached device, including ones this app holds no permission for
        // (each carries `hasPermission`). `getDevices` hides those, so discovery
        // needs this to know a device is there before asking for access.
        AsyncFunction("listDevices") {
            return@AsyncFunction listDevices()
        }

        AsyncFunction("requestPermission") { deviceName: String, promise: Promise ->
            try {
                val device = getDeviceByName(deviceName)
                if (usbManager.hasPermission(device)) {
                    promise.resolve(true)
                } else {
                    // Registering the waiter and draining it on the broadcast share one
                    // lock: if the grant landed in between, this promise would be added
                    // to a list nobody owns any more and the JS await would never settle.
                    val isFirstWaiter = synchronized(permissionLock) {
                        val waiters = pendingPermissionPromises.getOrPut(device.deviceName) { mutableListOf() }
                        waiters.add(promise)
                        waiters.size == 1
                    }
                    // One dialog per device: later callers just join the waiter list.
                    if (isFirstWaiter) {
                        devicesRequestedPermissions.add(device.deviceName)
                        usbManager.requestPermission(device, permissionIntent)
                    }
                }
            } catch (e: Exception) {
                Log.e(LOG_TAG, "Failed to request permission for device $deviceName")
                promise.reject("USB Permission Error", e.message, e)
            }
        }

        AsyncFunction("open") { deviceName: String ->
            return@AsyncFunction openDevice(deviceName)
        }

        AsyncFunction("reset") { deviceName: String ->
            return@AsyncFunction resetDevice(deviceName)
        }

        AsyncFunction("close") { deviceName: String ->
            return@AsyncFunction closeDevice(deviceName)
        }

        AsyncFunction("claimInterface") { deviceName: String, interfaceNumber: Int ->
            return@AsyncFunction claimInterface(deviceName, interfaceNumber)
        }

        AsyncFunction("releaseInterface") { deviceName: String, interfaceNumber: Int ->
            return@AsyncFunction releaseInterface(deviceName, interfaceNumber)
        }

        AsyncFunction("transferOut") { deviceName: String, endpointNumber: Int, data: ByteArray, promise: Promise ->
            val dataClone = data.copyOf()

            withModuleScope(promise) {
                try {
                    val result = transferOut(deviceName, endpointNumber, dataClone)
                    promise.resolve(result)
                } catch (e: Exception) {
                    promise.reject("USB Write Error", e.message, e)
                    Log.e(LOG_TAG, "Failed to transfer data to device $deviceName")
                }
            }
        }

        AsyncFunction("transferIn") { deviceName: String, endpointNumber: Int, length: Int, promise: Promise ->
            withModuleScope(promise) {
                try {
                    val result = transferIn(deviceName, endpointNumber, length)
                    promise.resolve(result)
                } catch (e: Exception) {
                    promise.reject("USB Read Error", e.message, e)
                    Log.e(LOG_TAG, "Failed to transfer data from device $deviceName")
                }
            }
        }

        OnCreate {
            val onDeviceConnect: OnDeviceConnect = { device ->
                Log.d(LOG_TAG, "New connection detected checking permission for device: $device")

                if (!isTrezor(device)) {
                    Log.d(LOG_TAG, "Ignoring non-Trezor device: $device")
                } else if (usbManager.hasPermission(device)) {
                    Log.d(LOG_TAG, "onDeviceConnected: $device")
                    val webUsbDevice = getWebUSBDevice(device)
                    sendEvent(ON_DEVICE_CONNECT_EVENT_NAME, webUsbDevice)
                    devicesHistory[device.deviceName] = webUsbDevice
                } else if (isAppInForeground) {
                    Log.d(LOG_TAG, "Request permission for device: $device")
                    devicesRequestedPermissions.add(device.deviceName)

                    usbManager.requestPermission(device, permissionIntent)
                }
            }
            val onDeviceDisconnect: OnDeviceDisconnect = { deviceName ->
                Log.d(LOG_TAG, "onDeviceDisconnected: ${devicesHistory[deviceName]}")

                if (devicesHistory[deviceName] == null) {
                    Log.e(LOG_TAG, "Device $deviceName not found in history.")
                }

                devicesHistory[deviceName]?.let { sendEvent(ON_DEVICE_DISCONNECT_EVENT_NAME, it) }
                Log.d(LOG_TAG, "Disconnect event sent for device ${devicesHistory[deviceName]}")

                devicesRequestedPermissions.remove(deviceName)
                openedConnections.remove(deviceName)
            }

            // Without this the permission dialog is a dead end: the grant lands in
            // the receiver and nothing re-emits the device, so JS never learns it
            // became usable until the next foreground transition.
            val onPermissionResolved: OnPermissionResolved = { isGranted, device ->
                Log.d(LOG_TAG, "Permission resolved for ${device.deviceName}: $isGranted")
                devicesRequestedPermissions.remove(device.deviceName)

                if (isGranted) {
                    val webUsbDevice = getWebUSBDevice(device)
                    devicesHistory[device.deviceName] = webUsbDevice
                    sendEvent(ON_DEVICE_CONNECT_EVENT_NAME, webUsbDevice)
                }

                val waiters = synchronized(permissionLock) { pendingPermissionPromises.remove(device.deviceName) }
                waiters?.forEach { it.resolve(isGranted) }
            }

            ReactNativeUsbAttachedReceiver.setOnDeviceConnectCallback(onDeviceConnect)
            ReactNativeUsbDetachedReceiver.setOnDeviceDisconnectCallback(onDeviceDisconnect)
            ReactNativeUsbPermissionReceiver.setOnDevicePermissionCallback(onPermissionResolved)
        }

        OnActivityEntersForeground {
            isAppInForeground = true

            val devicesList = usbManager.deviceList.values.filter { isTrezor(it) }
            for (device in devicesList) {
                if (usbManager.hasPermission(device)) {
                    Log.d(LOG_TAG, "Has permission, send event onDeviceConnected: $device")

                    val webUsbDevice = if (hasOpenedConnection(device.deviceName)) {
                        Log.d(LOG_TAG, "Device already opened: $device")
                        getWebUSBDevice(device)
                    } else {
                        Log.d(LOG_TAG, "Opening device: $device")
                        openDevice(device.deviceName)
                    }

                    sendEvent(ON_DEVICE_CONNECT_EVENT_NAME, webUsbDevice)
                    devicesHistory[device.deviceName] = webUsbDevice
                } else if (!devicesRequestedPermissions.contains(
                        device.deviceName
                    )
                ) {
                    Log.d(LOG_TAG, "New device connected while app was in background: $device")
                    devicesRequestedPermissions.add(device.deviceName)
                    usbManager.requestPermission(device, permissionIntent)
                } else {
                    Log.d(LOG_TAG, "Permission already requested for device: $device")
                }
            }
        }

        OnActivityEntersBackground {
            if (!isInPriorityMode) {
                isAppInForeground = false
                closeAllOpenedDevices()
            }
        }

        OnDestroy {
            ReactNativeUsbAttachedReceiver.setOnDeviceConnectCallback(null)
            ReactNativeUsbDetachedReceiver.setOnDeviceDisconnectCallback(null)
            ReactNativeUsbPermissionReceiver.setOnDevicePermissionCallback(null)

            rejectAllPendingPermissionPromises()
            cancelAllPendingRequests()
            closeAllOpenedDevices()

            try {
                moduleCoroutineScope.cancel(ModuleDestroyedException())
            } catch (e: IllegalStateException) {
                Log.e(LOG_TAG, "The scope does not have a job in it")
            }
        }

    }

    private inline fun withModuleScope(promise: Promise, crossinline block: () -> Unit) =
        moduleCoroutineScope.launch {
            try {
                block()
            } catch (e: CodedException) {
                promise.reject(e)
            } catch (e: ModuleDestroyedException) {
                promise.reject(LOG_TAG, "React Native USB module destroyed", e)
            }
        }

    private val context: Context
        get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

    private val usbManager: UsbManager
        get() = context.getSystemService(Context.USB_SERVICE) as UsbManager


    private val openedConnections = ConcurrentHashMap<String, UsbDeviceConnection>()
    private val pendingRequests = ConcurrentHashMap<String, UsbRequest>()
    private val pendingPermissionPromises = mutableMapOf<String, MutableList<Promise>>()

    /** Guards `pendingPermissionPromises` against the permission broadcast thread. */
    private val permissionLock = Any()

    private val devicesHistory = mutableMapOf<String, WebUSBDevice>()

    private fun openDevice(deviceName: String): WebUSBDevice {
        Log.d(LOG_TAG, "Opening device $deviceName")
        val device = getDeviceByName(deviceName)

        val usbConnection = usbManager.openDevice(device)
        if (usbConnection == null) {
            Log.e(LOG_TAG, "Failed to open device ${device.deviceName}")
            throw Exception("Failed to open device ${device.deviceName}")
        }

        openedConnections[device.deviceName] = usbConnection

        val usbInterface = device.getInterface(0)
        for (i in 0 until usbInterface.endpointCount) {
            val endpoint = usbInterface.getEndpoint(i)
            Log.d(LOG_TAG, "endpoint: $endpoint")
        }


        return getWebUSBDevice(device)
    }

    private fun resetDevice(deviceName: String) {
        Log.d(LOG_TAG, "Resetting device $deviceName")
        val usbRequest = pendingRequests.remove(deviceName)
        usbRequest?.cancel()
    }

    private fun closeDevice(deviceName: String) {
        Log.d(LOG_TAG, "Closing device $deviceName")
        getOpenedConnection(deviceName).close()
        openedConnections.remove(deviceName)
    }

    private fun closeAllOpenedDevices() {
        Log.d(LOG_TAG, "Closing all devices")

        openedConnections.values.forEach { it.close() }
        openedConnections.clear()
    }

    private fun cancelAllPendingRequests() {
        pendingRequests.values.forEach { it.cancel() }
        pendingRequests.clear()
    }

    private fun rejectAllPendingPermissionPromises() {
        val pending = synchronized(permissionLock) {
            val all = pendingPermissionPromises.values.flatten()
            pendingPermissionPromises.clear()
            all
        }
        pending.forEach { it.reject(LOG_TAG, "React Native USB module destroyed", null) }
    }

    private fun claimInterface(deviceName: String, interfaceNumber: Int) {
        Log.d(LOG_TAG, "Claiming interface $interfaceNumber for device $deviceName")
        val device = getDeviceByName(deviceName)
        val usbConnection = getOpenedConnection(deviceName)
        val usbInterface = device.getInterface(interfaceNumber)
        if (usbInterface == null) {
            Log.e(
                LOG_TAG,
                "Failed to get interface $interfaceNumber for device ${device.deviceName}"
            )
            throw Exception("Failed to get interface $interfaceNumber for device ${device.deviceName}")
        }
        usbConnection.claimInterface(usbInterface, true)
    }

    private fun releaseInterface(deviceName: String, interfaceNumber: Int) {
        Log.d(LOG_TAG, "Releasing interface $interfaceNumber for device $deviceName")
        val device = getDeviceByName(deviceName)
        val usbConnection = getOpenedConnection(deviceName)
        val usbInterface = device.getInterface(interfaceNumber)
        if (usbInterface == null) {
            Log.e(
                LOG_TAG,
                "Failed to get interface $interfaceNumber for device ${device.deviceName}"
            )
            throw Exception("Failed to get interface $interfaceNumber for device ${device.deviceName}")
        }
        usbConnection.releaseInterface(usbInterface)
    }

    /**
     * Detects the protocol and returns the appropriate chunk header.
     * - Protocol v1: First byte is 0x3F ('?'), chunk header is 1 byte (0x3F)
     * - Protocol v2 (THP): First byte is a THP control byte, chunk header is 3 bytes (0x80 + channel)
     */
    private fun getChunkHeader(data: ByteArray): ByteArray {
        val firstByte = data[0]

        return if (firstByte == PROTOCOL_V1_MAGIC_BYTE) {
            Log.d(LOG_TAG, "Detected protocol v1, using 1-byte chunk header")
            byteArrayOf(PROTOCOL_V1_MAGIC_BYTE)
        } else {
            if (data.size < THP_HEADER_SIZE) {
                Log.w(LOG_TAG, "Data too short for THP header, falling back to v1 header")
                byteArrayOf(PROTOCOL_V1_MAGIC_BYTE)
            } else {
                val channelHigh = data[1]
                val channelLow = data[2]
                Log.d(LOG_TAG, "Detected protocol v2 (THP), using 3-byte chunk header with channel ${channelHigh.toInt() and 0xFF}:${channelLow.toInt() and 0xFF}")
                byteArrayOf(THP_CONTINUATION_PACKET, channelHigh, channelLow)
            }
        }
    }

    /**
     * Creates 64-byte chunks from data for USB transfer.
     *
     * Supports Protocol v1 (1-byte header) and Protocol v2/THP (3-byte header)
     */
    private fun createChunks(data: ByteArray): List<ByteArray> {
        val dataSize = data.size

        if (dataSize <= CHUNK_SIZE) {
            val chunk = ByteArray(CHUNK_SIZE)
            System.arraycopy(data, 0, chunk, 0, dataSize)
            return listOf(chunk)
        }

        val chunkHeader = getChunkHeader(data)
        val chunkHeaderSize = chunkHeader.size
        val chunkDataSize = CHUNK_SIZE - chunkHeaderSize

        val chunks = mutableListOf<ByteArray>()
        var dataOffset = 0

        val firstChunk = ByteArray(CHUNK_SIZE)
        System.arraycopy(data, 0, firstChunk, 0, CHUNK_SIZE)
        chunks.add(firstChunk)
        dataOffset = CHUNK_SIZE

        while (dataOffset < dataSize) {
            val chunk = ByteArray(CHUNK_SIZE)
            System.arraycopy(chunkHeader, 0, chunk, 0, chunkHeaderSize)
            val bytesToCopy = minOf(chunkDataSize, dataSize - dataOffset)
            System.arraycopy(data, dataOffset, chunk, chunkHeaderSize, bytesToCopy)
            chunks.add(chunk)
            dataOffset += bytesToCopy
        }

        return chunks
    }

    /**
     * Transfers data to USB device, chunking if necessary.
     * Uses bulkTransfer for efficient sequential transfers.
     */
    private fun transferOut(deviceName: String, endpointNumber: Int, data: ByteArray): Int {
        val transferStartTime = System.nanoTime()

        val device = getDeviceByName(deviceName)
        val usbConnection = openedConnections.getOrPut(device.deviceName) {
            Log.d(LOG_TAG, "transferOut: Reopening device ${device.deviceName}")
            usbManager.openDevice(device) ?: throw Exception("Failed to open device ${device.deviceName}")
        }

        val usbEndpoint = device.getInterface(INTERFACE_INDEX).getEndpoint(1)
        if (usbEndpoint == null) {
            Log.e(LOG_TAG, "Failed to get endpoint $endpointNumber for device ${device.deviceName}")
            throw Exception("Failed to get endpoint $endpointNumber for device ${device.deviceName}")
        }

        val chunks = createChunks(data)
        val totalChunks = chunks.size
        val bulkTimeout = 0

        for ((index, chunk) in chunks.withIndex()) {
            val bytesWritten = usbConnection.bulkTransfer(usbEndpoint, chunk, CHUNK_SIZE, bulkTimeout)

            if (bytesWritten < 0) {
                Log.e(LOG_TAG, "transferOut: FAILED chunk ${index + 1}/$totalChunks, error: $bytesWritten")
                throw Exception("USB transfer failed for chunk ${index + 1}/$totalChunks, error: $bytesWritten")
            }

            if (bytesWritten != CHUNK_SIZE) {
                Log.e(LOG_TAG, "transferOut: FAILED chunk ${index + 1}/$totalChunks incomplete: $bytesWritten/$CHUNK_SIZE")
                throw Exception("USB transfer incomplete for chunk ${index + 1}/$totalChunks: $bytesWritten/$CHUNK_SIZE bytes")
            }
        }

        val durationMs = (System.nanoTime() - transferStartTime) / 1_000_000.0
        Log.d(LOG_TAG, "transferOut: Done - ${data.size} bytes, $totalChunks chunks, %.1f ms".format(durationMs))

        return data.size
    }

    private fun transferIn(deviceName: String, endpointNumber: Int, length: Int): ByteArray {
        Log.d(LOG_TAG, "Reading data from device $deviceName")
        val device = getDeviceByName(deviceName)

        val usbConnection = openedConnections.getOrPut(device.deviceName) {
            Log.d(LOG_TAG, "Reopening device ${device.deviceName}")
            usbManager.openDevice(device) ?: throw Exception("Failed to open device ${device.deviceName}")
        }

        val usbEndpoint = device.getInterface(INTERFACE_INDEX).getEndpoint(0)

        if (usbEndpoint == null) {
            Log.e(LOG_TAG, "Failed to get endpoint $endpointNumber for device ${device.deviceName}")
            throw Exception("Failed to get endpoint $endpointNumber for device ${device.deviceName}")
        }

        val buffer = ByteBuffer.allocate(length)
        val req = UsbRequest()
        req.initialize(usbConnection, usbEndpoint)
        req.queue(buffer)

        if (pendingRequests.putIfAbsent(device.deviceName, req) != null) {
            req.cancel()
            req.close()
            Log.e(LOG_TAG, "Transfer already in progress for device ${device.deviceName}")
            throw Exception("Transfer already in progress for device ${device.deviceName}")
        }

        val result = try {
            usbConnection.requestWait()
        } finally {
            pendingRequests.remove(device.deviceName)
            req.close()
        }

        if (result == null) {
            Log.e(LOG_TAG, "Failed to transfer data from device ${device.deviceName}")
            throw Exception("Failed to transfer data from device ${device.deviceName}")
        }

        Log.d(LOG_TAG, "Read data from device ${device.deviceName}: $length bytes")
        return buffer.array()
    }

    private fun getOpenedConnection(deviceName: String): UsbDeviceConnection {
        Log.d(LOG_TAG, "getOpenedConnection: $deviceName")
        return openedConnections[deviceName] ?: throw Exception("Device $deviceName not opened")
    }

    private fun hasOpenedConnection(deviceName: String): Boolean {
        val isConnectionOpened = openedConnections.containsKey(deviceName)
        Log.d(LOG_TAG, "Device $deviceName hasOpenedConnection: $isConnectionOpened")
        return isConnectionOpened
    }

    private fun getDeviceByName(deviceName: String): UsbDevice {
        Log.d(LOG_TAG, "getDeviceByName: $deviceName")
        val devices = usbManager.deviceList.values.toList()
        for (device in devices) {
            if (device.deviceName == deviceName) {
                return device
            }
        }
        throw Exception("Device $deviceName not found")
    }

    private fun getDevices(): List<Map<String, Any?>> {
        Log.d(LOG_TAG, "getDevices")
        val devices = mutableListOf<WebUSBDevice>()
        val devicesList = usbManager.deviceList.values.toList()
        Log.d(LOG_TAG, "deviceList: $devicesList")
        for (i in 0 until devicesList.size) {
            val device = devicesList[i]
            if (!usbManager.hasPermission(device)) {
                Log.d(LOG_TAG, "device: ${device.deviceName} has no permission, skipping")
                continue
            }
            val webUsbDevice = getWebUSBDevice(device)
            devices.add(webUsbDevice)
            devicesHistory[device.deviceName] = webUsbDevice
        }
        Log.d(LOG_TAG, "getDevices: $devices")
        return devices
    }

    private fun isTrezor(device: UsbDevice): Boolean = (device.vendorId to device.productId) in TREZOR_USB_IDS

    private fun listDevices(): List<Map<String, Any?>> {
        val devices = usbManager.deviceList.values.map { getWebUSBDevice(it) }
        Log.d(LOG_TAG, "listDevices: $devices")
        return devices
    }

    private fun getWebUSBDevice(device: UsbDevice): WebUSBDevice {
        val hasPermission = usbManager.hasPermission(device)
        return mapOf(
            "deviceName" to device.deviceName,
            "deviceClass" to device.deviceClass,
            "deviceSubclass" to device.deviceSubclass,
            "deviceProtocol" to device.deviceProtocol,
            "vendorId" to device.vendorId,
            "productId" to device.productId,
            "manufacturerName" to device.manufacturerName,
            "productName" to device.productName,
            // getSerialNumber() throws SecurityException on API 29+ without device
            // permission, which would take the whole enumeration down with it.
            "serialNumber" to if (hasPermission) runCatching { device.serialNumber }.getOrNull() else null,
            "opened" to hasOpenedConnection(device.deviceName),
            "hasPermission" to hasPermission,
        )
    }
}
