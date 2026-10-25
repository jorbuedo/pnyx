package expo.modules.passkeynative

import android.os.Build
import androidx.credentials.CreateCredentialResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PasskeyUnsupportedException(message: String) : CodedException(message)

class PasskeyCancelledException : CodedException("The user cancelled the passkey prompt")

class PasskeyNoCredentialException : CodedException("No matching passkey is available on this device")

class PasskeyFailedException(message: String) : CodedException(message)

/**
 * Bridges the Android Credential Manager (androidx.credentials) passkey API to JS.
 *
 * The JS layer builds the full WebAuthn request JSON (including the PRF extension
 * with the salt) and parses the raw response JSON — this module is a pass-through
 * over `createCredential` / `getCredential` with typed error mapping. Passkeys
 * with PRF need Android 9+ (API 28) and a credential provider (Google Password
 * Manager); `isAvailable()` is false and the functions throw
 * ERR_PASSKEY_UNSUPPORTED when either is missing, so callers fail soft.
 */
class PasskeyNativeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PasskeyNative")

    Function("isAvailable") {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && credentialManagerOrNull() != null
    }

    AsyncFunction("create") { requestJson: String, promise: Promise ->
      val activity = requireActivity(promise) ?: return@AsyncFunction
      val manager = requireManager(promise) ?: return@AsyncFunction
      val request = CreatePublicKeyCredentialRequest(requestJson)
      manager.createCredentialAsync(
        activity,
        request,
        null,
        activity.mainExecutor,
        object : CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException> {
          override fun onResult(result: CreateCredentialResponse) {
            if (result is CreatePublicKeyCredentialResponse) {
              promise.resolve(result.registrationResponseJson)
            } else {
              promise.reject(PasskeyFailedException("Unexpected credential type: ${result.type}"))
            }
          }

          override fun onError(e: CreateCredentialException) {
            promise.reject(mapCreateError(e))
          }
        },
      )
    }

    AsyncFunction("get") { requestJson: String, promise: Promise ->
      val activity = requireActivity(promise) ?: return@AsyncFunction
      val manager = requireManager(promise) ?: return@AsyncFunction
      val request = GetCredentialRequest(listOf(GetPublicKeyCredentialOption(requestJson)))
      manager.getCredentialAsync(
        activity,
        request,
        null,
        activity.mainExecutor,
        object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
          override fun onResult(result: GetCredentialResponse) {
            val credential = result.credential
            if (credential is PublicKeyCredential) {
              promise.resolve(credential.authenticationResponseJson)
            } else {
              promise.reject(PasskeyFailedException("Unexpected credential type: ${credential.type}"))
            }
          }

          override fun onError(e: GetCredentialException) {
            promise.reject(mapGetError(e))
          }
        },
      )
    }
  }

  private fun credentialManagerOrNull(): CredentialManager? =
    try {
      val context = appContext.reactContext ?: return null
      CredentialManager.create(context)
    } catch (e: Throwable) {
      null
    }

  private fun requireActivity(promise: Promise): android.app.Activity? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
      promise.reject(PasskeyUnsupportedException("Passkeys require Android 9 or newer"))
      return null
    }
    val activity = appContext.currentActivity
    if (activity == null) {
      promise.reject(PasskeyFailedException("No foreground activity to present the passkey prompt"))
    }
    return activity
  }

  private fun requireManager(promise: Promise): CredentialManager? {
    val manager = credentialManagerOrNull()
    if (manager == null) {
      promise.reject(PasskeyUnsupportedException("Credential Manager is unavailable on this device"))
    }
    return manager
  }

  private fun mapCreateError(e: CreateCredentialException): CodedException =
    when (e) {
      is CreateCredentialCancellationException -> PasskeyCancelledException()
      else -> PasskeyFailedException("Passkey creation failed: ${e.message ?: e.type}")
    }

  private fun mapGetError(e: GetCredentialException): CodedException =
    when (e) {
      is GetCredentialCancellationException -> PasskeyCancelledException()
      is NoCredentialException -> PasskeyNoCredentialException()
      else -> PasskeyFailedException("Passkey assertion failed: ${e.message ?: e.type}")
    }
}
