// BLE bridge loader — must be an external script (MV3 blocks inline scripts).
// Reads ?device= query param and loads the device-specific bridge script.
;(() => {
  // Theme: read preference from extension storage — dark by default
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['pnyx_theme_mode'], (result) => {
      if (result.pnyx_theme_mode === 'false') {
        document.documentElement.classList.add('light')
      }
    })
  }

  // Parameterize the page based on ?device= query parameter
  var params = new URLSearchParams(window.location.search)
  var device = params.get('device') || 'ledger'
  var heading = document.getElementById('heading')
  var connectBtn = document.getElementById('connect-btn')
  var notice = document.getElementById('notice')

  if (device === 'trezor') {
    document.title = 'Trezor Bluetooth Bridge'
    if (heading) heading.textContent = 'Trezor Bluetooth Bridge'
    if (connectBtn) connectBtn.textContent = 'Select Trezor Device'
    if (notice)
      notice.textContent =
        'Keep this tab open while using your Trezor over Bluetooth. Closing it will disconnect the device.'
  } else {
    document.title = 'Ledger Bluetooth Bridge'
    if (heading) heading.textContent = 'Ledger Bluetooth Bridge'
    if (connectBtn) connectBtn.textContent = 'Select Ledger Device'
    if (notice)
      notice.textContent =
        'Keep this tab open while using your Ledger over Bluetooth. Closing it will disconnect the device.'
  }

  // Load the device-specific bridge script
  var script = document.createElement('script')
  script.src = device === 'trezor' ? 'trezor-ble-bridge.js' : 'ledger-ble-bridge.js'
  document.body.appendChild(script)
})()
