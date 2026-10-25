import AuthenticationServices
import CryptoKit
import ExpoModulesCore
import UIKit

/// Coded exceptions mirroring the Android surface. Expo derives the JS error
/// `code` from the class name (`PasskeyCancelledException` → `ERR_PASSKEY_CANCELLED`),
/// which is what `packages/passkey-native/src/index.ts` matches on.
final class PasskeyUnsupportedException: Exception {
  override var reason: String { "Passkeys with the PRF extension require iOS 18 or newer" }
}

final class PasskeyCancelledException: Exception {
  override var reason: String { "The user cancelled the passkey prompt" }
}

final class PasskeyNoCredentialException: Exception {
  override var reason: String { "No matching passkey is available on this device" }
}

final class PasskeyFailedException: GenericException<String> {
  override var reason: String { "Passkey operation failed: \(param)" }
}

/// Bridges iOS platform passkeys (`AuthenticationServices`) to JS, mirroring the
/// Android Credential Manager module.
///
/// The JS layer (`webauthn.ts`) builds the WebAuthn request JSON (with the PRF
/// extension + salt) and parses the response JSON. Android's Credential Manager
/// consumes/returns that JSON directly; iOS has no JSON pass-through, so this
/// module parses the request JSON into an `ASAuthorization` request and rebuilds
/// a WebAuthn-shaped response JSON from the typed result — critically the
/// credential id and `clientExtensionResults.prf.results.first`, which is all
/// `parsePasskeyResponseJson` reads.
///
/// PRF (the WebAuthn `prf` extension) needs iOS 18+; below that `isAvailable()`
/// is `false` and the functions throw `PasskeyUnsupportedException`, so the JS
/// layer treats iOS exactly like any other unsupported platform (fail soft).
public class PasskeyNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PasskeyNative")

    Function("isAvailable") { () -> Bool in
      if #available(iOS 18.0, *) { return true }
      return false
    }

    AsyncFunction("create") { (requestJson: String, promise: Promise) in
      guard #available(iOS 18.0, *) else {
        promise.reject(PasskeyUnsupportedException())
        return
      }
      DispatchQueue.main.async {
        do {
          let req = try CreateRequest(json: requestJson)
          let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: req.rpId)
          let request = provider.createCredentialRegistrationRequest(
            challenge: req.challenge, name: req.userName, userID: req.userId)
          request.userVerificationPreference = .required
          // Registration only enables PRF; the deterministic output is produced
          // on the first assertion (get) with the salt. This mirrors the
          // "prfOutput may be null on create" contract in webauthn.ts.
          request.prf = .checkForSupport
          PasskeyCoordinator.run(request: request, promise: promise)
        } catch {
          promise.reject(asPasskeyError(error))
        }
      }
    }

    AsyncFunction("get") { (requestJson: String, promise: Promise) in
      guard #available(iOS 18.0, *) else {
        promise.reject(PasskeyUnsupportedException())
        return
      }
      DispatchQueue.main.async {
        do {
          let req = try GetRequest(json: requestJson)
          let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: req.rpId)
          let request = provider.createCredentialAssertionRequest(challenge: req.challenge)
          request.userVerificationPreference = .required
          if let credentialId = req.credentialId {
            request.allowedCredentials = [
              ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: credentialId)
            ]
          }
          request.prf = .inputValues(
            ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues(
              saltInput1: req.prfSalt, saltInput2: nil),
            perCredentialInputValues: nil)
          PasskeyCoordinator.run(request: request, promise: promise)
        } catch {
          promise.reject(asPasskeyError(error))
        }
      }
    }
  }
}

// MARK: - Request parsing

private struct CreateRequest {
  let rpId: String
  let userName: String
  let userId: Data
  let challenge: Data
  let prfSalt: Data

  init(json: String) throws {
    let root = try jsonObject(json)
    guard let rp = root["rp"] as? [String: Any], let rpId = rp["id"] as? String else {
      throw PasskeyFailedException("missing rp.id")
    }
    guard let user = root["user"] as? [String: Any],
      let userIdText = user["id"] as? String,
      let userName = user["name"] as? String
    else {
      throw PasskeyFailedException("missing user.id / user.name")
    }
    guard let challengeText = root["challenge"] as? String else {
      throw PasskeyFailedException("missing challenge")
    }
    self.rpId = rpId
    self.userName = userName
    self.userId = try base64UrlDecode(userIdText)
    self.challenge = try base64UrlDecode(challengeText)
    self.prfSalt = try prfSaltFrom(root)
  }
}

private struct GetRequest {
  let rpId: String
  let challenge: Data
  let prfSalt: Data
  let credentialId: Data?

  init(json: String) throws {
    let root = try jsonObject(json)
    guard let rpId = root["rpId"] as? String else { throw PasskeyFailedException("missing rpId") }
    guard let challengeText = root["challenge"] as? String else {
      throw PasskeyFailedException("missing challenge")
    }
    self.rpId = rpId
    self.challenge = try base64UrlDecode(challengeText)
    self.prfSalt = try prfSaltFrom(root)
    if let allow = root["allowCredentials"] as? [[String: Any]],
      let idText = allow.first?["id"] as? String
    {
      self.credentialId = try base64UrlDecode(idText)
    } else {
      self.credentialId = nil
    }
  }
}

private func jsonObject(_ json: String) throws -> [String: Any] {
  guard let data = json.data(using: .utf8),
    let root = try JSONSerialization.jsonObject(with: data) as? [String: Any]
  else {
    throw PasskeyFailedException("request is not a JSON object")
  }
  return root
}

private func prfSaltFrom(_ root: [String: Any]) throws -> Data {
  guard let extensions = root["extensions"] as? [String: Any],
    let prf = extensions["prf"] as? [String: Any],
    let eval = prf["eval"] as? [String: Any],
    let first = eval["first"] as? String
  else {
    throw PasskeyFailedException("missing extensions.prf.eval.first")
  }
  return try base64UrlDecode(first)
}

// MARK: - ASAuthorization delegate bridge

@available(iOS 18.0, *)
private final class PasskeyCoordinator: NSObject, ASAuthorizationControllerDelegate,
  ASAuthorizationControllerPresentationContextProviding
{
  private let promise: Promise
  private var selfRetain: PasskeyCoordinator?

  private init(promise: Promise) {
    self.promise = promise
    super.init()
    self.selfRetain = self
  }

  static func run(request: ASAuthorizationRequest, promise: Promise) {
    let coordinator = PasskeyCoordinator(promise: promise)
    let controller = ASAuthorizationController(authorizationRequests: [request])
    controller.delegate = coordinator
    controller.presentationContextProvider = coordinator
    controller.performRequests()
  }

  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
    return windows.first(where: { $0.isKeyWindow }) ?? windows.first ?? ASPresentationAnchor()
  }

  func authorizationController(
    controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization
  ) {
    defer { selfRetain = nil }
    do {
      if let registration = authorization.credential
        as? ASAuthorizationPlatformPublicKeyCredentialRegistration
      {
        promise.resolve(try registrationResponseJson(registration))
      } else if let assertion = authorization.credential
        as? ASAuthorizationPlatformPublicKeyCredentialAssertion
      {
        promise.resolve(try assertionResponseJson(assertion))
      } else {
        promise.reject(PasskeyFailedException("unexpected credential type"))
      }
    } catch {
      promise.reject(asPasskeyError(error))
    }
  }

  func authorizationController(
    controller: ASAuthorizationController, didCompleteWithError error: Error
  ) {
    defer { selfRetain = nil }
    promise.reject(asPasskeyError(error))
  }
}

// MARK: - Response JSON assembly

@available(iOS 18.0, *)
private func registrationResponseJson(
  _ registration: ASAuthorizationPlatformPublicKeyCredentialRegistration
) throws -> String {
  let id = base64UrlEncode(registration.credentialID)
  var response: [String: Any] = [
    "clientDataJSON": base64UrlEncode(registration.rawClientDataJSON)
  ]
  if let attestation = registration.rawAttestationObject {
    response["attestationObject"] = base64UrlEncode(attestation)
  }
  var prf: [String: Any] = ["enabled": registration.prf != nil]
  if let first = registration.prf?.first {
    prf["results"] = ["first": base64UrlEncode(symmetricKeyData(first))]
  }
  let payload: [String: Any] = [
    "id": id,
    "rawId": id,
    "type": "public-key",
    "authenticatorAttachment": "platform",
    "response": response,
    "clientExtensionResults": ["prf": prf],
  ]
  return try encodeJson(payload)
}

@available(iOS 18.0, *)
private func assertionResponseJson(
  _ assertion: ASAuthorizationPlatformPublicKeyCredentialAssertion
) throws -> String {
  let id = base64UrlEncode(assertion.credentialID)
  var response: [String: Any] = [
    "clientDataJSON": base64UrlEncode(assertion.rawClientDataJSON),
    "authenticatorData": base64UrlEncode(assertion.rawAuthenticatorData),
    "signature": base64UrlEncode(assertion.signature),
  ]
  if let userId = assertion.userID {
    response["userHandle"] = base64UrlEncode(userId)
  }
  var prf: [String: Any] = [:]
  if let first = assertion.prf?.first {
    prf["results"] = ["first": base64UrlEncode(symmetricKeyData(first))]
  }
  let payload: [String: Any] = [
    "id": id,
    "rawId": id,
    "type": "public-key",
    "authenticatorAttachment": "platform",
    "response": response,
    "clientExtensionResults": ["prf": prf],
  ]
  return try encodeJson(payload)
}

/// The `prf` extension surfaces its output as a CryptoKit `SymmetricKey`; the
/// WebAuthn JSON needs the raw bytes.
private func symmetricKeyData(_ key: SymmetricKey) -> Data {
  return key.withUnsafeBytes { Data($0) }
}

private func encodeJson(_ payload: [String: Any]) throws -> String {
  let data = try JSONSerialization.data(withJSONObject: payload)
  guard let text = String(data: data, encoding: .utf8) else {
    throw PasskeyFailedException("failed to encode response JSON")
  }
  return text
}

// MARK: - Error mapping

private func asPasskeyError(_ error: Error) -> Exception {
  if let exception = error as? Exception { return exception }
  if let authError = error as? ASAuthorizationError {
    switch authError.code {
    case .canceled: return PasskeyCancelledException()
    default: return PasskeyFailedException(authError.localizedDescription)
    }
  }
  return PasskeyFailedException(error.localizedDescription)
}

// MARK: - base64url (unpadded, matching webauthn.ts)

private func base64UrlEncode(_ data: Data) -> String {
  var text = data.base64EncodedString()
  text = text.replacingOccurrences(of: "+", with: "-")
  text = text.replacingOccurrences(of: "/", with: "_")
  text = text.replacingOccurrences(of: "=", with: "")
  return text
}

private func base64UrlDecode(_ text: String) throws -> Data {
  var padded = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  let remainder = padded.count % 4
  if remainder > 0 { padded += String(repeating: "=", count: 4 - remainder) }
  guard let data = Data(base64Encoded: padded) else {
    throw PasskeyFailedException("invalid base64url value")
  }
  return data
}
