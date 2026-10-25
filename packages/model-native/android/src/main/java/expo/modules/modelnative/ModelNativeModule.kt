package expo.modules.modelnative

import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.prompt.GenerateContentRequest
import com.google.mlkit.genai.prompt.GenerateTypedContentRequest
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.GenerativeModel
import com.google.mlkit.genai.prompt.TextPart
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONException
import org.json.JSONObject

class ModelUnavailableException(message: String) : CodedException(message)

class ModelGenerationFailedException(message: String) : CodedException(message)

class ModelDownloadFailedException(message: String) : CodedException(message)

class ModelSchemaInvalidException(message: String) : CodedException(message)

class ModelSchemaUnsupportedException(message: String) : CodedException(message)

/**
 * Bridges the ML Kit GenAI Prompt API (Gemini Nano via AICore) to JS.
 *
 * Text in, text out. No tool calling and no streaming: item 38's invariant is that
 * a model can never reach anything, and the narrowest possible surface is how that
 * is enforced rather than promised.
 *
 * `FeatureStatus` maps onto the JS `ModelAvailability` union one-to-one, which is
 * why that union has four members instead of a boolean — on this platform the model
 * is provisioned on demand through AICore, so "not yet" and "never" are genuinely
 * different states and only the first resolves by waiting.
 *
 * Devices without AICore (every emulator, and non-flagship hardware) report
 * UNAVAILABLE, so the app's affordance simply does not appear.
 */
class ModelNativeModule : Module() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  /**
   * Built lazily and reused. `getClient()` is cheap but not free, and the model
   * holds a download/warmup state we want to keep across calls rather than reset.
   */
  private val model: GenerativeModel by lazy { Generation.getClient() }

  override fun definition() = ModuleDefinition {
    Name("ModelNative")

    Events(DOWNLOAD_EVENT)

    AsyncFunction("getStatus") { promise: Promise ->
      scope.launch {
        // Deliberately never rejects: a device that cannot answer is a device where
        // the feature is unavailable, and every call site would map a throw to
        // exactly that. `reason` carries the detail for the dev probe.
        try {
          val status = model.checkStatus()
          // Only meaningful once a model is actually there, and both are suspend calls into
          // AICore — asking on a device that has none is a slow way to get an exception.
          val available = status == FeatureStatus.AVAILABLE
          promise.resolve(
            mapOf(
              "availability" to availabilityOf(status),
              "reason" to if (status == FeatureStatus.UNAVAILABLE) "FeatureStatus.UNAVAILABLE" else null,
              // Asked of the device rather than assumed. Which model AICore provisions varies by
              // hardware, so a build-time constant would promise constrained decoding on a device
              // whose model cannot do it and only fail at generation.
              "supportsStructuredOutput" to (available && runCatching { model.isStructuredOutputFeatureAvailable() }.getOrDefault(false)),
              "modelName" to if (available) runCatching { model.getBaseModelName() }.getOrNull() else null,
            ),
          )
        } catch (e: Throwable) {
          promise.resolve(
            mapOf(
              "availability" to "unavailable",
              "reason" to (e.message ?: e.toString()),
              "supportsStructuredOutput" to false,
            ),
          )
        }
      }
    }

    // Provisioning is explicit and user-initiated, never a side effect of asking for an
    // explanation: AICore fetches the weights on demand and that is a large download the
    // user should agree to spend data and storage on.
    AsyncFunction("downloadModel") { promise: Promise ->
      scope.launch {
        try {
          model.download().collect { status ->
            when (status) {
              is DownloadStatus.DownloadStarted ->
                sendEvent(
                  DOWNLOAD_EVENT,
                  mapOf("phase" to "started", "totalBytes" to status.bytesToDownload.toDouble(), "downloadedBytes" to 0.0),
                )
              is DownloadStatus.DownloadProgress ->
                sendEvent(
                  DOWNLOAD_EVENT,
                  mapOf("phase" to "progress", "downloadedBytes" to status.totalBytesDownloaded.toDouble()),
                )
              is DownloadStatus.DownloadCompleted -> sendEvent(DOWNLOAD_EVENT, mapOf("phase" to "completed"))
              // Surfaced as a rejection rather than only an event, so a caller awaiting the
              // download cannot mistake a failure for a completed one.
              is DownloadStatus.DownloadFailed -> throw status.e
            }
          }
          promise.resolve(null)
        } catch (e: Throwable) {
          promise.reject(ModelDownloadFailedException(e.message ?: e.toString()))
        }
      }
    }

    AsyncFunction("generate") { prompt: String, promise: Promise ->
      scope.launch {
        try {
          val status = model.checkStatus()
          if (status != FeatureStatus.AVAILABLE) {
            promise.reject(ModelUnavailableException("model status ${availabilityOf(status)}"))
            return@launch
          }
          val response = model.generateContent(prompt)
          // `candidates` can legitimately come back empty when the platform's own
          // guardrails refuse the prompt. That is a failure to the caller, not an
          // empty explanation to show a user.
          val text = response.candidates.firstOrNull()?.text
          if (text.isNullOrBlank()) {
            promise.reject(ModelGenerationFailedException("model returned no candidate text"))
          } else {
            promise.resolve(text)
          }
        } catch (e: Throwable) {
          promise.reject(ModelGenerationFailedException(e.message ?: e.toString()))
        }
      }
    }

    AsyncFunction("generateStructured") { prompt: String, schema: String, promise: Promise ->
      scope.launch {
        try {
          val parsed =
            try {
              JSONObject(schema)
            } catch (e: JSONException) {
              promise.reject(ModelSchemaInvalidException(e.message ?: "schema is not a JSON object"))
              return@launch
            }
          // Checked before availability so a mismatched schema is reported as one on every
          // device, including the ones that have no model to ask.
          //
          // Rejects rather than falling back to `generate`: a caller that asked for a
          // constrained field and silently got prose would validate whatever came back.
          if (!matchesExplanationSchema(parsed)) {
            promise.reject(
              ModelSchemaUnsupportedException(
                "this build can only decode the Explanation shape; see Generables.kt",
              ),
            )
            return@launch
          }

          val status = model.checkStatus()
          if (status != FeatureStatus.AVAILABLE) {
            promise.reject(ModelUnavailableException("model status ${availabilityOf(status)}"))
            return@launch
          }

          val request = GenerateContentRequest.Builder(TextPart(prompt)).build()
          val typed = GenerateTypedContentRequest.Builder(request, Explanation::class).build()
          val explanation = model.generateContent(typed).candidates.firstOrNull()?.response
          if (explanation == null) {
            promise.reject(ModelGenerationFailedException("model returned no candidate"))
          } else {
            promise.resolve(explanation.toJson())
          }
        } catch (e: Throwable) {
          promise.reject(ModelGenerationFailedException(e.message ?: e.toString()))
        }
      }
    }
  }

  private companion object {
    const val DOWNLOAD_EVENT = "onModelDownloadProgress"
  }

  private fun availabilityOf(status: Int): String =
    when (status) {
      FeatureStatus.AVAILABLE -> "available"
      FeatureStatus.DOWNLOADABLE -> "downloadable"
      FeatureStatus.DOWNLOADING -> "downloading"
      else -> "unavailable"
    }
}
