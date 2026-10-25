import ExpoModulesCore

#if canImport(FoundationModels)
  import FoundationModels
#endif

/** A schema the caller sent that cannot be represented, reported back verbatim. */
struct ModelSchemaError: Error {
  let message: String
}

#if canImport(FoundationModels)
  /**
   Builds a `DynamicGenerationSchema` from the caller's serialised `ModelSchema`.

   Recursive and total: every shape the JS union can express maps to exactly one case
   here, and anything else throws rather than silently degrading to free text — a
   caller that thinks a field is constrained and gets prose would validate garbage.
   */
  @available(iOS 26.0, *)
  private func dynamicSchema(from node: Any, path: String) throws -> DynamicGenerationSchema {
    guard let dict = node as? [String: Any], let type = dict["type"] as? String else {
      throw ModelSchemaError(message: "schema node at \(path) is not an object with a type")
    }
    switch type {
    case "string": return DynamicGenerationSchema(type: String.self)
    case "boolean": return DynamicGenerationSchema(type: Bool.self)
    case "integer": return DynamicGenerationSchema(type: Int.self)
    case "number": return DynamicGenerationSchema(type: Double.self)
    case "enum":
      guard let values = dict["values"] as? [String], !values.isEmpty else {
        throw ModelSchemaError(message: "enum at \(path) needs a non-empty values array")
      }
      return DynamicGenerationSchema(name: "\(path).enum", anyOf: values)
    case "array":
      guard let items = dict["items"] else {
        throw ModelSchemaError(message: "array at \(path) needs an items schema")
      }
      return DynamicGenerationSchema(
        arrayOf: try dynamicSchema(from: items, path: "\(path)[]"),
        minimumElements: dict["minItems"] as? Int,
        maximumElements: dict["maxItems"] as? Int
      )
    case "object":
      guard let name = dict["name"] as? String, let properties = dict["properties"] as? [[String: Any]] else {
        throw ModelSchemaError(message: "object at \(path) needs a name and properties")
      }
      let built: [DynamicGenerationSchema.Property] = try properties.map { property in
        guard let propertyName = property["name"] as? String, let schema = property["schema"] else {
          throw ModelSchemaError(message: "property of \(path) needs a name and a schema")
        }
        return DynamicGenerationSchema.Property(
          name: propertyName,
          description: property["description"] as? String,
          schema: try dynamicSchema(from: schema, path: "\(path).\(propertyName)"),
          isOptional: property["optional"] as? Bool ?? false
        )
      }
      return DynamicGenerationSchema(name: name, description: dict["description"] as? String, properties: built)
    default:
      throw ModelSchemaError(message: "unknown schema type '\(type)' at \(path)")
    }
  }
#endif

/**
 Bridges Apple's Foundation Models on-device system model to JS.

 Text in, text out, plus schema-constrained text out. No tool calling: item 38's
 invariant is that a model can never reach anything, and the narrowest possible surface
 is how that is enforced rather than promised. `FoundationModels` is only importable on
 an SDK that has it, and the availability check is gated again at runtime, so this file
 compiles and runs on older OS versions and simply reports `unavailable` there. The
 linker weak-links `FoundationModels` on its own — every use sits behind `@available`
 and the framework postdates the 16.4 deployment target — so no `weak_frameworks` entry
 is required.
 */
public class ModelNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ModelNative")

    AsyncFunction("getStatus") { (promise: Promise) in
      // Never rejects — a device that cannot answer is a device where the feature is
      // unavailable, and every call site would map a throw to exactly that.
      #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
          switch SystemLanguageModel.default.availability {
          case .available:
            // Constrained decoding ships in the same framework as generation, so on this
            // platform "the model can answer" and "the model can answer to a schema" are
            // the same condition.
            promise.resolve(["availability": "available", "reason": nil, "supportsStructuredOutput": true])
          case .unavailable(let reason):
            // `modelNotReady` is Apple Intelligence still preparing the model, which
            // resolves by waiting — the same state Android calls DOWNLOADING. Every
            // other reason is permanent for this device.
            switch reason {
            case .modelNotReady:
              promise.resolve(["availability": "downloading", "reason": "modelNotReady"])
            default:
              promise.resolve(["availability": "unavailable", "reason": "\(reason)"])
            }
          @unknown default:
            promise.resolve(["availability": "unavailable", "reason": "unknown availability case"])
          }
          return
        }
      #endif
      promise.resolve([
        "availability": "unavailable",
        "reason": "FoundationModels requires iOS 26",
        "supportsStructuredOutput": false,
      ])
    }

    AsyncFunction("generateStructured") { (prompt: String, schema: String, promise: Promise) in
      #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
          guard case .available = SystemLanguageModel.default.availability else {
            promise.reject("ERR_MODEL_UNAVAILABLE", "the system language model is not available")
            return
          }
          Task {
            do {
              guard let data = schema.data(using: .utf8),
                let node = try JSONSerialization.jsonObject(with: data) as? [String: Any]
              else {
                throw ModelSchemaError(message: "schema is not a JSON object")
              }
              let root = try dynamicSchema(from: node, path: "root")
              let generationSchema = try GenerationSchema(root: root, dependencies: [])
              let session = LanguageModelSession()
              let response = try await session.respond(to: prompt, schema: generationSchema)
              // Handed back as JSON text rather than a bridged record: the decoder
              // guarantees the shape, and re-encoding through Expo's record bridging
              // would be a second place for the shape to change.
              promise.resolve(response.content.jsonString)
            } catch let error as ModelSchemaError {
              promise.reject("ERR_MODEL_SCHEMA_INVALID", error.message)
            } catch {
              promise.reject("ERR_MODEL_GENERATION_FAILED", error.localizedDescription)
            }
          }
          return
        }
      #endif
      promise.reject("ERR_MODEL_STRUCTURED_UNSUPPORTED", "constrained decoding requires iOS 26")
    }

    // Apple Intelligence provisions its own model and exposes no app-triggerable
    // download, so this cannot be implemented rather than merely being unimplemented.
    // Rejecting is the honest answer; the UI offers the affordance only on platforms
    // that can act on it.
    AsyncFunction("downloadModel") { (promise: Promise) in
      promise.reject("ERR_DOWNLOAD_UNSUPPORTED", "the system model is provisioned by the OS on this platform")
    }

    AsyncFunction("generate") { (prompt: String, promise: Promise) in
      #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
          guard case .available = SystemLanguageModel.default.availability else {
            promise.reject("ERR_MODEL_UNAVAILABLE", "the system language model is not available")
            return
          }
          Task {
            do {
              let session = LanguageModelSession()
              let response = try await session.respond(to: prompt)
              let text = response.content.trimmingCharacters(in: .whitespacesAndNewlines)
              if text.isEmpty {
                promise.reject("ERR_MODEL_GENERATION_FAILED", "model returned no content")
              } else {
                promise.resolve(text)
              }
            } catch {
              // Guardrail refusals and context overflow both land here. A failure to
              // the caller, never an empty explanation shown to a user.
              promise.reject("ERR_MODEL_GENERATION_FAILED", error.localizedDescription)
            }
          }
          return
        }
      #endif
      promise.reject("ERR_MODEL_UNAVAILABLE", "FoundationModels requires iOS 26")
    }
  }
}
