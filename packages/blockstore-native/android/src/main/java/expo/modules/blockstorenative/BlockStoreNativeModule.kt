package expo.modules.blockstorenative

import com.google.android.gms.auth.blockstore.Blockstore
import com.google.android.gms.auth.blockstore.BlockstoreClient
import com.google.android.gms.auth.blockstore.DeleteBytesRequest
import com.google.android.gms.auth.blockstore.RetrieveBytesRequest
import com.google.android.gms.auth.blockstore.StoreBytesData
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class BlockStoreUnavailableException : CodedException("Block Store (Play Services) is unavailable on this device")

class BlockStoreFailedException(message: String) : CodedException(message)

/**
 * Bridges Google Block Store (`play-services-auth-blockstore`) to JS: small,
 * cross-device, end-to-end-encrypted key/value storage backed up to the user's
 * Google account. Holds the passkey-wrapped recovery blob so a new device can
 * fetch it (the ciphertext is useless without the passkey's PRF output).
 *
 * `setShouldBackupToCloud(true)` opts each entry into cross-device sync; if the
 * user has no screen lock or cloud backup the entry stays device-local rather
 * than failing. iOS has no equivalent — that platform uses a cloudSync keychain
 * item instead (see the app's synced-recovery-store.ios.ts), so this module is
 * Android-only.
 */
class BlockStoreNativeModule : Module() {
  private fun clientOrNull(): BlockstoreClient? {
    val context = appContext.reactContext ?: return null
    return try {
      Blockstore.getClient(context)
    } catch (e: Throwable) {
      null
    }
  }

  override fun definition() = ModuleDefinition {
    Name("BlockStoreNative")

    Function("isAvailable") {
      clientOrNull() != null
    }

    AsyncFunction("setItem") { key: String, value: String, promise: Promise ->
      val client = clientOrNull()
      if (client == null) {
        promise.reject(BlockStoreUnavailableException())
        return@AsyncFunction
      }
      val data = StoreBytesData.Builder()
        .setBytes(value.toByteArray(Charsets.UTF_8))
        .setKey(key)
        .setShouldBackupToCloud(true)
        .build()
      client.storeBytes(data)
        .addOnSuccessListener { promise.resolve(null) }
        .addOnFailureListener { e -> promise.reject(BlockStoreFailedException(e.message ?: "storeBytes failed")) }
    }

    AsyncFunction("getItem") { key: String, promise: Promise ->
      val client = clientOrNull()
      if (client == null) {
        promise.reject(BlockStoreUnavailableException())
        return@AsyncFunction
      }
      val request = RetrieveBytesRequest.Builder().setKeys(listOf(key)).build()
      client.retrieveBytes(request)
        .addOnSuccessListener { response ->
          val entry = response.blockstoreDataMap[key]
          if (entry == null) {
            promise.resolve(null)
          } else {
            promise.resolve(String(entry.bytes, Charsets.UTF_8))
          }
        }
        .addOnFailureListener { e -> promise.reject(BlockStoreFailedException(e.message ?: "retrieveBytes failed")) }
    }

    AsyncFunction("removeItem") { key: String, promise: Promise ->
      val client = clientOrNull()
      if (client == null) {
        promise.reject(BlockStoreUnavailableException())
        return@AsyncFunction
      }
      val request = DeleteBytesRequest.Builder().setKeys(listOf(key)).build()
      client.deleteBytes(request)
        .addOnSuccessListener { promise.resolve(null) }
        .addOnFailureListener { e -> promise.reject(BlockStoreFailedException(e.message ?: "deleteBytes failed")) }
    }
  }
}
