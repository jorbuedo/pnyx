/**
 * WebView provider injection for the in-app dApp browser (mobile-only).
 *
 * Bridge contract:
 * - page → host: the provider posts `JSON.stringify(DappMessage)` via
 *   `window.ReactNativeWebView.postMessage`. `DappMessage` = `{id, sessionId,
 *   chainType: 'cardano', method, params, origin: window.location.origin}`;
 *   ids are `"<sessionId>:<n>"` with `n` monotonically increasing.
 * - host → page: the host delivers each `WalletResponse` (`{id, result?,
 *   error?: {code, message, data?}}`) by evaluating
 *   `window.__pnyxDappResponse(<response object or JSON string>)` in the
 *   WebView (e.g. `webView.injectJavaScript`). The script resolves the pending
 *   request with the matching `id`; unknown ids are ignored.
 * - a request with no response after 5 minutes rejects with
 *   `{code: -2, message: 'request timed out'}`.
 *
 * Rejections are surfaced to the dApp as `TxSignError` (signTx),
 * `DataSignError` (signData / cip95_signData), or `APIError` (everything
 * else), matching CIP-30.
 *
 * @module
 */

export type InjectionConfig = {
  readonly walletName: string
  /** data: URI for the provider icon. */
  readonly walletIcon?: string
  readonly apiVersion: string
  readonly sessionId: string
  /** `window.cardano.<name>` keys to install (first is canonical). */
  readonly providerNames: readonly string[]
  /**
   * Message transport. `'webview'` (default) posts over the React Native WebView
   * bridge for the in-app browser. `'extension'` posts over `window.postMessage`
   * for a browser-extension content-script relay. Both carry the identical
   * `DappMessage`/`WalletResponse` wire (see `docs/EXTENSION.md`).
   */
  readonly transport?: 'webview' | 'extension'
  /**
   * Reverse-DNS wallet id for `window.midnight`, e.g. `uk.pxkq.pnyx`.
   *
   * The Midnight connector identifies wallets by this rather than by a registry key, and asks that it
   * stay stable for the product's lifetime — so it is configuration, not a derived value.
   */
  readonly midnightRdns: string
  /**
   * The UUID this wallet installs itself under in `window.midnight`.
   *
   * The API keys the registry by UUID (CAIP-372 draft), one per API instance, and expects it stable.
   * A fresh one per injection would make a dApp treat every page load as a different wallet.
   */
  readonly midnightUuid: string
  /**
   * The name the Midnight provider reports, and the extra `window.midnight.<key>` slots it installs
   * itself under.
   *
   * ⚠️ **Separate from `walletName`, which is the Cardano identity.** They used to be the same value,
   * so choosing "Eternl" for Cardano also renamed the Midnight provider — and Eternl ships no
   * Midnight provider at all, so that was never a name any dApp expected to see there.
   *
   * ⚠️ **`name` is what dApps actually match on.** Measured against Ascend's shipped bundle: it
   * enumerates the registry and tests ``[key, name].join(' ').toLowerCase().includes('lace')``,
   * never reading `rdns`. `keys` covers the other style in the wild, a hardcoded
   * `window.midnight.mnLace`. Omit to fall back to `walletName` and the UUID slot alone.
   */
  readonly midnightIdentity?: {readonly name: string; readonly keys: readonly string[]}
  /** The `@midnight-ntwrk/dapp-connector-api` version implemented — see {@link MIDNIGHT_API_VERSION}. */
  readonly midnightApiVersion: string
  /**
   * Which registries to install. Both default to `true`.
   *
   * Independent switches because they are independent surfaces: a user may want Cardano dApps to see
   * this wallet and not Midnight ones, or the reverse. A single "inject" flag could not express that.
   */
  readonly install?: {readonly cardano?: boolean; readonly midnight?: boolean}
}

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000

export const RESPONSE_CALLBACK = '__pnyxDappResponse'

/**
 * This wallet's reverse-DNS id for `window.midnight`.
 *
 * The Midnight connector identifies wallets by this and asks that it stay stable for the product's
 * lifetime, so it is a constant rather than something derived from a build variant — a `.dev` suffix
 * here would make the dev build look like a different wallet to every dApp.
 */
export const MIDNIGHT_WALLET_RDNS = 'uk.pxkq.pnyx'

/**
 * The UUID this wallet installs itself under in `window.midnight`.
 *
 * The registry is keyed by UUID (CAIP-372 draft), one per API instance, and a dApp may remember it. It
 * must therefore be **fixed**: generating one per injection would make every page load look like a new
 * wallet, and a `Math.random` id would defeat the "keep it stable" instruction outright.
 */
export const MIDNIGHT_WALLET_UUID = 'd7b6c0a2-4e91-4f3a-9c68-1b5a2e7f8d34'

/**
 * The version reported to a Midnight dApp.
 *
 * ⚠️ **Not the wallet's own version.** The API says this is "a version of the API package
 * `@midnight-ntwrk/dapp-connector-api` that was used in implementation", and dApps branch on it. It was
 * briefly reporting the CIP-30 provider's `0.1.0`, which would have told every Midnight dApp we
 * implement a version that does not exist.
 *
 * `4.1.0` rather than the canary's full string: the canary is how we obtain 4.1, not a different
 * contract, and a dApp comparing versions should see the release it corresponds to.
 */
export const MIDNIGHT_API_VERSION = '4.1.0'

/** Build the JS injected before page content loads. Idempotent per provider name. */
export const generateInjectionScript = (config: InjectionConfig): string => {
  if (config.providerNames.length === 0) throw new Error('at least one provider name is required')
  const transport = config.transport ?? 'webview'
  // Page → host send line. Both transports carry the same `message` object.
  const sendLine =
    transport === 'extension'
      ? 'window.postMessage({__pnyxDappRequest: message}, window.location.origin);'
      : 'window.ReactNativeWebView.postMessage(JSON.stringify(message));'
  // Extension delivers host → page responses via window messages; feed them into
  // the same callback the WebView bridge invokes directly.
  const responseListener =
    transport === 'extension'
      ? `\n  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || typeof d !== 'object' || d.__pnyxDappResponse == null) return;
    window.${RESPONSE_CALLBACK}(d.__pnyxDappResponse);
  });\n`
      : ''
  const cfg = JSON.stringify({
    walletName: config.walletName,
    walletIcon: config.walletIcon ?? '',
    apiVersion: config.apiVersion,
    sessionId: config.sessionId,
    providerNames: config.providerNames,
    midnightRdns: config.midnightRdns,
    midnightUuid: config.midnightUuid,
    midnightName: config.midnightIdentity?.name ?? config.walletName,
    midnightKeys: config.midnightIdentity?.keys ?? [],
    midnightApiVersion: config.midnightApiVersion,
    installCardano: config.install?.cardano ?? true,
    installMidnight: config.install?.midnight ?? true,
  })
  return `(function () {
  'use strict';
  var CONFIG = ${cfg};
  var TIMEOUT_MS = ${REQUEST_TIMEOUT_MS};
  var SUPPORTED_EXTENSIONS = [{cip: 95}, {cip: 142}, {cip: 139}];
  var pending = new Map();
  var counter = 0;

  if (window.${RESPONSE_CALLBACK}) return;
  window.${RESPONSE_CALLBACK} = function (response) {
    var r = response;
    if (typeof r === 'string') {
      try { r = JSON.parse(r); } catch (e) { return; }
    }
    if (!r || typeof r.id !== 'string') return;
    var entry = pending.get(r.id);
    if (!entry) return;
    pending.delete(r.id);
    clearTimeout(entry.timer);
    // apiCode travels for a Midnight page only, and is what the Midnight provider turns into the API's
    // string error code — dropping it here would silently flatten every refusal to InternalError.
    if (r.error) entry.reject({code: r.error.code, message: r.error.message, data: r.error.data, apiCode: r.error.apiCode});
    else entry.resolve(r.result);
  };
${responseListener}
  function post(chainType, method, params) {
    counter += 1;
    var id = CONFIG.sessionId + ':' + counter.toString(36);
    var message = {
      id: id,
      sessionId: CONFIG.sessionId,
      chainType: chainType,
      method: method,
      params: params,
      origin: window.location.origin,
    };
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        pending.delete(id);
        reject({code: -2, message: 'request timed out'});
      }, TIMEOUT_MS);
      pending.set(id, {resolve: resolve, reject: reject, timer: timer});
      ${sendLine}
    });
  }

  function ApiError(code, info) { this.name = 'APIError'; this.code = code; this.info = info; this.message = info; }
  function TxSignError(code, info) { this.name = 'TxSignError'; this.code = code; this.info = info; this.message = info; }
  function DataSignError(code, info) { this.name = 'DataSignError'; this.code = code; this.info = info; this.message = info; }
  ApiError.prototype = Object.create(Error.prototype);
  TxSignError.prototype = Object.create(Error.prototype);
  DataSignError.prototype = Object.create(Error.prototype);

  function call(method, params) {
    return post('cardano', method, params).catch(function (e) {
      var code = e && typeof e.code === 'number' ? e.code : -1;
      var info = e && e.message ? e.message : 'unknown error';
      if (method === 'signTx') throw new TxSignError(code, info);
      if (method === 'signData' || method === 'cip95_signData') throw new DataSignError(code, info);
      throw new ApiError(code, info);
    });
  }

  function buildApi() {
    return {
      getExtensions: function () { return call('getExtensions'); },
      getNetworkId: function () { return call('getNetworkId'); },
      getBalance: function () { return call('getBalance'); },
      getUtxos: function (amount, paginate) { return call('getUtxos', {amount: amount, paginate: paginate}); },
      getCollateral: function (params) { return call('getCollateral', params); },
      getUsedAddresses: function (paginate) { return call('getUsedAddresses', {paginate: paginate}); },
      getUnusedAddresses: function () { return call('getUnusedAddresses'); },
      getChangeAddress: function () { return call('getChangeAddress'); },
      getRewardAddresses: function () { return call('getRewardAddresses'); },
      signTx: function (tx, partialSign) { return call('signTx', {tx: tx, partialSign: partialSign === true}); },
      signData: function (addr, payload) { return call('signData', {addr: addr, payload: payload}); },
      submitTx: function (tx) { return call('submitTx', {tx: tx}); },
      cip95: {
        getPubDRepKey: function () { return call('cip95_getPubDRepKey'); },
        getRegisteredPubStakeKeys: function () { return call('cip95_getRegisteredPubStakeKeys'); },
        getUnregisteredPubStakeKeys: function () { return call('cip95_getUnregisteredPubStakeKeys'); },
        signData: function (addr, payload) { return call('cip95_signData', {addr: addr, payload: payload}); },
      },
      cip142: {
        getNetworkMagic: function () { return call('cip142_getNetworkMagic'); },
      },
      // CIP-139 Universal Query Layer. Exposed under BOTH shapes the CIP documents,
      // because its two transport documents disagree: cip-0144.md (the wallet-extension
      // binding) names flat operations, while ts-api.md defines a nested \`api.query.*\`
      // for injected JavaScript — which is this transport. They are aliases over the
      // same calls, so a dApp written against either document works.
      cip139: {
        getUtxosByAddress: function (a) { return call('cip139_getUtxosByAddress', a); },
        getUtxosByAsset: function (n, p) { return call('cip139_getUtxosByAsset', {asset_name: n, minting_policy_hash: p}); },
        getUtxosByPaymentCredential: function (c) { return call('cip139_getUtxosByPaymentCredential', c); },
        getUtxosByStakeCredential: function (r) { return call('cip139_getUtxosByStakeCredential', r); },
        getUtxosByTransactionHash: function (t) { return call('cip139_getUtxosByTransactionHash', t); },
        getProtocolParametersByLatest: function () { return call('cip139_getProtocolParametersByLatest'); },
        getProtocolParametersByEpoch: function (e) { return call('cip139_getProtocolParametersByEpoch', e); },
        getVotesByDrepId: function (i) { return call('cip139_getVotesByDrepId', i); },
        getVotesBySpoId: function (i) { return call('cip139_getVotesBySpoId', i); },
        getVotesByCcId: function (i) { return call('cip139_getVotesByCcId', i); },
        getVotesByProposalId: function (i) { return call('cip139_getVotesByProposalId', i); },
        getAllDreps: function () { return call('cip139_getAllDreps'); },
        getDrepById: function (i) { return call('cip139_getDrepById', i); },
        getDrepByStakeCredential: function (r) { return call('cip139_getDrepByStakeCredential', r); },
        getAllCommitteeMembers: function () { return call('cip139_getAllCommitteeMembers'); },
        getCommitteeMemberById: function (i) { return call('cip139_getCommitteeMemberById', i); },
        getAllPools: function () { return call('cip139_getAllPools'); },
        getPoolById: function (i) { return call('cip139_getPoolById', i); },
        getAllProposals: function () { return call('cip139_getAllProposals'); },
        getProposalById: function (i) { return call('cip139_getProposalById', i); },
      },
      query: {
        utxos: {
          address: function (a) { return call('cip139_getUtxosByAddress', a); },
          asset: function (n, p) { return call('cip139_getUtxosByAsset', {asset_name: n, minting_policy_hash: p}); },
          payment_credential: function (c) { return call('cip139_getUtxosByPaymentCredential', c); },
          stake_credential: function (r) { return call('cip139_getUtxosByStakeCredential', r); },
          transaction_hash: function (t) { return call('cip139_getUtxosByTransactionHash', t); },
        },
        protocol_parameters: {
          latest: function () { return call('cip139_getProtocolParametersByLatest'); },
          epoch: function (e) { return call('cip139_getProtocolParametersByEpoch', e); },
        },
        votes: {
          drep_id: function (i) { return call('cip139_getVotesByDrepId', i); },
          spo_id: function (i) { return call('cip139_getVotesBySpoId', i); },
          cc_id: function (i) { return call('cip139_getVotesByCcId', i); },
          proposal_id: function (i) { return call('cip139_getVotesByProposalId', i); },
        },
        drep: {
          all: function () { return call('cip139_getAllDreps'); },
          id: function (i) { return call('cip139_getDrepById', i); },
          stake_credential: function (r) { return call('cip139_getDrepByStakeCredential', r); },
        },
        committee: {
          all: function () { return call('cip139_getAllCommitteeMembers'); },
          id: function (i) { return call('cip139_getCommitteeMemberById', i); },
        },
        pool: {
          all: function () { return call('cip139_getAllPools'); },
          id: function (i) { return call('cip139_getPoolById', i); },
        },
        proposal: {
          all: function () { return call('cip139_getAllProposals'); },
          id: function (i) { return call('cip139_getProposalById', i); },
        },
      },
      // NOT CIP-139, and under the namespace CIP-30 reserves for exactly this. \`tip\` is
      // the one a tx-building dApp cannot do without: CIP-139 defines no chain-tip
      // operation, so there is no standard way to learn the current slot for a validity
      // interval. \`resolveOutpoints\` batches what 139 can only ask for per transaction,
      // and preserves \`spent\`, which CIP-116 has no field for.
      experimental: {
        tip: function () { return call('experimental_tip'); },
        resolveOutpoints: function (refs) { return call('experimental_resolveOutpoints', refs); },
      },
    };
  }

  var initialApi = {
    name: CONFIG.walletName,
    icon: CONFIG.walletIcon || undefined,
    apiVersion: CONFIG.apiVersion,
    supportedExtensions: SUPPORTED_EXTENSIONS,
    isEnabled: function () {
      return call('isEnabled').then(function (r) { return r === true; }).catch(function () { return false; });
    },
    enable: function (extensions) {
      return call('enable', extensions ? {extensions: extensions} : undefined).then(function (granted) {
        if (granted === true) return buildApi();
        throw new ApiError(-3, 'connection refused');
      });
    },
  };

  if (CONFIG.installCardano) {
  if (!window.cardano) {
    try { window.cardano = {}; } catch (e) {
      try { Object.defineProperty(window, 'cardano', {value: {}, writable: true, configurable: true}); } catch (e2) {}
    }
  }
  var registry = window.cardano;
  var installed = false;
  if (registry && Object.isExtensible(registry)) {
    for (var i = 0; i < CONFIG.providerNames.length; i++) {
      var name = CONFIG.providerNames[i];
      if (registry[name]) continue;
      try { registry[name] = initialApi; installed = true; } catch (e3) {
        try {
          Object.defineProperty(registry, name, {value: initialApi, writable: true, configurable: true, enumerable: true});
          installed = true;
        } catch (e4) {}
      }
    }
  }
  if (installed) window.dispatchEvent(new Event('cardano.walletLoaded'));
  }

  if (CONFIG.installMidnight) {
  // ── window.midnight ──────────────────────────────────────────────────────────────────────────────
  //
  // A different shape from CIP-30, not a second name for it: the registry is keyed by UUID (CAIP-372
  // draft), the wallet is identified by reverse-DNS, and connect(networkId) returns the connected API
  // directly rather than a boolean from enable().
  //
  // Errors are the API's own APIError, not CIP-30's: an Error carrying type 'DAppConnectorAPIError',
  // a **string** code from the spec's six-value union, and reason. The spec says to discriminate on
  // type, so a dApp branching on ErrorCodes.PermissionRejected sees nothing at all from a numeric
  // CIP-30 error — which is what this provider used to send. message is kept alongside reason because
  // it is an Error and every logger reads it.
  var MIDNIGHT_ERROR_TYPE = 'DAppConnectorAPIError';
  // The fallback when the host names no code: only for a reply that predates apiCode or a transport
  // failure. InternalError is the honest one — the request did not get a verdict.
  var MIDNIGHT_CODE_BY_WIRE = {'-1': 'InvalidRequest', '-2': 'InternalError', '-3': 'Rejected', '-4': 'Disconnected'};

  function MidnightError(apiCode, reason) {
    var error = new Error(reason);
    error.name = 'MidnightConnectorError';
    error.type = MIDNIGHT_ERROR_TYPE;
    error.code = apiCode;
    error.reason = reason;
    return error;
  }

  function mnCall(method, params) {
    return post('midnight', method, params).catch(function (e) {
      var named = e && typeof e.apiCode === 'string' ? e.apiCode : null;
      var mapped = e && typeof e.code === 'number' ? MIDNIGHT_CODE_BY_WIRE[String(e.code)] : null;
      throw MidnightError(named || mapped || 'InternalError', (e && e.message) || 'unknown error');
    });
  }

  // Atomic amounts cross the bridge as decimal strings, because JSON cannot carry a bigint and a Number
  // would round anything past 2^53. The API promises the dApp bigints, so they are restored here — at
  // the only boundary that can do it without loss.
  function toBig(value) {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'string') return BigInt(value);
    // Never coerce a Number: if one ever arrives it has already lost precision, and a silently wrong
    // balance is worse than a failed call.
    throw MidnightError('InternalError', 'the wallet returned a non-decimal amount');
  }

  function toHexBytes(bytes) {
    if (typeof bytes === 'string') return bytes;
    var view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var out = '';
    for (var i = 0; i < view.length; i++) {
      var b = view[i].toString(16);
      out += b.length === 1 ? '0' + b : b;
    }
    return out;
  }

  // SHA-256 over the concatenated *bytes*, so the digest matches what the wallet computes over the same
  // material — and so nothing here builds a hex string of a 10 MB prover key just to identify it.
  // Measured: hashing the hex form instead cost ~8 s per call on device, which is as much as proving.
  function sha256OfBytes(parts) {
    var total = 0;
    for (var i = 0; i < parts.length; i++) total += parts[i].length;
    var joined = new Uint8Array(total);
    var at = 0;
    for (var j = 0; j < parts.length; j++) { joined.set(parts[j], at); at += parts[j].length; }
    return crypto.subtle.digest('SHA-256', joined).then(function (buf) { return toHexBytes(new Uint8Array(buf)); });
  }

  function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    return new Uint8Array(value);
  }

  function fromHexBytes(hexText) {
    var out = new Uint8Array(hexText.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hexText.substr(i * 2, 2), 16);
    return out;
  }

  // A binding input is a field element, and the ledger reads it little-endian in 32 bytes. A bigint has
  // no length of its own, so the padding is the conversion: a shorter encoding would be a different
  // scalar, and the wallet refuses anything that is not exactly 32.
  function frToLeHex(value) {
    if (typeof value !== 'bigint') {
      throw MidnightError('InvalidRequest', 'overwriteBindingInput must be a bigint');
    }
    if (value < 0n) {
      throw MidnightError('InvalidRequest', 'overwriteBindingInput must not be negative');
    }
    var out = new Uint8Array(32);
    var rest = value;
    for (var i = 0; i < 32; i++) {
      out[i] = Number(rest & 0xffn);
      rest >>= 8n;
    }
    if (rest !== 0n) {
      throw MidnightError('InvalidRequest', 'overwriteBindingInput does not fit in 32 bytes');
    }
    return toHexBytes(out);
  }

  // Amounts go out the way balances come back: decimal strings, because JSON cannot carry a bigint and
  // a Number would round a Uint<128> past 2^53 into a transfer of the wrong size.
  function outputsToWire(outputs) {
    if (!Array.isArray(outputs)) return outputs;
    return outputs.map(function (o) {
      if (!o || typeof o !== 'object') return o;
      var value = o.value;
      if (typeof value === 'number') {
        // A Number has already lost whatever precision it was going to lose. Refusing beats sending an
        // amount that is nearly right.
        throw MidnightError('InvalidRequest', 'an output value must be a bigint, not a number');
      }
      return {kind: o.kind, type: o.type, value: typeof value === 'bigint' ? value.toString() : value, recipient: o.recipient};
    });
  }

  // A DesiredInput is an output without a recipient: the wallet chooses which of its own UTxOs to
  // spend, so the dApp names only the token and the amount.
  function inputsToWire(inputs) {
    if (!Array.isArray(inputs)) return inputs;
    return inputs.map(function (i) {
      if (!i || typeof i !== 'object') return i;
      var value = i.value;
      if (typeof value === 'number') {
        throw MidnightError('InvalidRequest', 'an input value must be a bigint, not a number');
      }
      return {kind: i.kind, type: i.type, value: typeof value === 'bigint' ? value.toString() : value};
    });
  }

  function bigMap(record) {
    var out = {};
    if (record) { for (var k in record) { if (Object.prototype.hasOwnProperty.call(record, k)) out[k] = toBig(record[k]); } }
    return out;
  }

  function midnightApi() {
    return {
      getUnshieldedBalances: function () { return mnCall('getUnshieldedBalances').then(bigMap); },
      getShieldedBalances: function () { return mnCall('getShieldedBalances').then(bigMap); },
      getDustBalance: function () {
        return mnCall('getDustBalance').then(function (r) {
          return {cap: toBig(r && r.cap), balance: toBig(r && r.balance)};
        });
      },
      getUnshieldedAddress: function () { return mnCall('getUnshieldedAddress'); },
      getDustAddress: function () { return mnCall('getDustAddress'); },
      getShieldedAddresses: function () { return mnCall('getShieldedAddresses'); },
      getTxHistory: function (pageNumber, pageSize) { return mnCall('getTxHistory', [pageNumber, pageSize]); },
      getConfiguration: function () { return mnCall('getConfiguration'); },
      getConnectionStatus: function () { return mnCall('getConnectionStatus'); },
      signData: function (data, options) { return mnCall('signData', [data, options]); },
      makeTransfer: function (desiredOutputs, options) {
        return mnCall('makeTransfer', [outputsToWire(desiredOutputs), options || {}]);
      },
      balanceUnsealedTransaction: function (tx, options) {
        return mnCall('balanceUnsealedTransaction', [tx, options || {}]);
      },
      // Declared and refused by the wallet, not stubbed here: the reason belongs to whoever decides it,
      // and it can become a real implementation without touching this file.
      balanceSealedTransaction: function (tx, options) {
        return mnCall('balanceSealedTransaction', [tx, options || {}]);
      },
      makeIntent: function (desiredInputs, desiredOutputs, options) {
        return mnCall('makeIntent', [inputsToWire(desiredInputs), outputsToWire(desiredOutputs), options || {}]);
      },
      // Not in the connector API — a wallet extension method a dApp feature-detects for.
      deriveAppSecret: function (domain) { return mnCall('deriveAppSecret', [domain]); },
      // The API hands us a KeyMaterialProvider and wants a ProvingProvider back. Both are objects with
      // methods, so neither crosses the bridge: the wallet is asked once whether this page may prove,
      // and the returned object lives here, pulling circuit material from the dApp's own provider and
      // sending it over per call. Nothing is cached page-side — the wallet caches by content digest, so
      // re-sending identical bytes is cheap and re-sending *different* bytes cannot collide.
      getProvingProvider: function (keyMaterialProvider) {
        if (!keyMaterialProvider || typeof keyMaterialProvider.getZKIR !== 'function') {
          return Promise.reject(MidnightError('InvalidRequest', 'getProvingProvider needs a key material provider'));
        }
        // What this provider knows about each circuit: absent = "try by digest", false = "the wallet
        // asked for the bytes", true = "sent". A prover key is megabytes and the bridge charged ~35 s
        // for 10 MB on device against ~4 s of actual proving, so the default is to send nothing and
        // let a miss ask.
        var sent = {};
        return mnCall('getProvingProvider').then(function () {
          return {
            check: function (serializedPreimage, keyLocation) {
              return Promise.resolve(keyMaterialProvider.getZKIR(keyLocation)).then(function (zkir) {
                return mnCall('provingProviderCheck', [toHexBytes(zkir), toHexBytes(serializedPreimage)]);
              }).then(function (skips) {
                // The API's shape is (bigint | undefined)[]. JSON has neither: an absent entry arrives
                // as null and a present one as a Number, so both are converted here rather than left
                // for a dApp to discover.
                return (skips || []).map(function (entry) {
                  return entry === null || entry === undefined ? undefined : BigInt(entry);
                });
              });
            },
            prove: function (serializedPreimage, keyLocation, overwriteBindingInput) {
              // All three at once: proving needs the prover key, and asking for it lazily would only
              // move the same bytes later. The check call deliberately asks for the ZKIR alone.
              return Promise.all([
                keyMaterialProvider.getZKIR(keyLocation),
                keyMaterialProvider.getProverKey(keyLocation),
                keyMaterialProvider.getVerifierKey(keyLocation),
              ]).then(function (material) {
                var zkir = asBytes(material[0]);
                var pk = asBytes(material[1]);
                var vk = asBytes(material[2]);
                var binding = overwriteBindingInput === undefined || overwriteBindingInput === null
                  ? null
                  : frToLeHex(overwriteBindingInput);
                return sha256OfBytes([zkir, pk, vk]).then(function (digest) {
                  // Hex is built only when the bytes are actually being sent: on a cache hit the 10 MB
                  // prover key is never stringified at all, which is where the time goes.
                  var call = function (withMaterial) {
                    return mnCall('provingProviderProve', withMaterial
                      ? [digest, toHexBytes(serializedPreimage), toHexBytes(zkir), toHexBytes(pk), toHexBytes(vk), binding]
                      : [digest, toHexBytes(serializedPreimage), '', '', '', binding]);
                  };
                  // Optimistic: ask by digest alone even the first time. The wallet caches circuits
                  // across sessions, so a dApp reopened tomorrow skips the megabytes too — and a miss
                  // costs one round trip, against ~35 s of bridge for guessing wrong the other way.
                  if (sent[digest] === false) {
                    return call(true).then(function (proof) { sent[digest] = true; return fromHexBytes(proof); });
                  }
                  return call(false).then(fromHexBytes, function () {
                    sent[digest] = false;
                    return call(true).then(function (proof) { sent[digest] = true; return fromHexBytes(proof); });
                  });
                });
              });
            },
          };
        });
      },
      submitTransaction: function (tx) {
        // The API returns void. Resolving with the wallet's reply would invent a result a dApp might
        // come to depend on.
        return mnCall('submitTransaction', [tx]).then(function () { return undefined; });
      },
      hintUsage: function (methodNames) { return mnCall('hintUsage', [methodNames]); },
      // ⚠️ Declaring is a promise to answer, and every method here keeps it — two of them by refusing
      // with a stated reason, which is an answer. This list and the resolver's method map are pinned to
      // each other by a test in injection.test.ts: getShieldedBalances once sat here with no handler
      // behind it at all, and every call threw a generic "not supported".
      //
      // Nothing is omitted. The spec marks no method of ConnectedAPI optional, so a dApp typed against
      // the SDK expects all of them, and an absent one hands it a TypeError where an APIError was due.
    };
  }

  var midnightInitial = {
    rdns: CONFIG.midnightRdns,
    name: CONFIG.midnightName,
    icon: CONFIG.walletIcon || '',
    apiVersion: CONFIG.midnightApiVersion,
    connect: function (networkId) {
      // A real wire call, not a status read: this is what asks the wallet for authorisation, and the
      // wallet is what refuses a network mismatch. Reading the status instead would hand a page the
      // connected API without anyone having approved it.
      return mnCall('connect', [networkId]).then(function () {
        return midnightApi();
      });
    },
  };

  if (!window.midnight) {
    try { window.midnight = {}; } catch (e5) {
      try { Object.defineProperty(window, 'midnight', {value: {}, writable: true, configurable: true}); } catch (e6) {}
    }
  }
  var mnRegistry = window.midnight;
  // The UUID slot is the spec's own shape; the named slots are for dApps that hardcode a key rather
  // than enumerate. Every slot holds the same object, so a dApp that finds two of them finds one
  // wallet twice rather than two wallets.
  var mnSlots = [CONFIG.midnightUuid].concat(CONFIG.midnightKeys || []);
  for (var mi = 0; mi < mnSlots.length; mi++) {
    var mnSlot = mnSlots[mi];
    // An existing entry is a real extension that got there first — never overwrite it, or the user
    // loses the wallet they actually installed.
    if (mnRegistry && Object.isExtensible(mnRegistry) && !mnRegistry[mnSlot]) {
      try { mnRegistry[mnSlot] = midnightInitial; } catch (e7) {
        try {
          Object.defineProperty(mnRegistry, mnSlot, {
            value: midnightInitial, writable: true, configurable: true, enumerable: true,
          });
        } catch (e8) {}
      }
    }
  }
  }
})();
true;`
}
