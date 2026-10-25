//! Diagnostics for the device rail — because a Rust panic never reaches JS.
//!
//! A panic raised inside an `extern "system"` JNI export cannot unwind across the boundary, so the
//! runtime calls `abort()`: SIGABRT, no Java exception, no JS error, and the panic message goes to
//! stderr, which Android discards. The result is a process that dies with the Metro log stopping
//! mid-operation and nothing to diagnose from.
//!
//! [`install`] puts the message, the location and a backtrace into logcat first (tag
//! `MidnightNative`), and [`note`] records a line with the process's resident size, so an abort that
//! is really memory exhaustion looks different from one that is not.

#[cfg(target_os = "android")]
mod imp {
    use std::backtrace::Backtrace;
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int};
    use std::sync::Once;

    #[link(name = "log")]
    extern "C" {
        fn __android_log_write(prio: c_int, tag: *const c_char, text: *const c_char) -> c_int;
    }

    const PRIO_INFO: c_int = 4;
    const PRIO_ERROR: c_int = 6;
    const TAG: &[u8] = b"MidnightNative\0";
    /// logcat drops a message past ~4 KiB; a backtrace is well past it.
    const CHUNK: usize = 3500;

    fn emit(prio: c_int, text: &str) {
        let tag = TAG.as_ptr() as *const c_char;
        let mut rest = text;
        loop {
            let mut cut = rest.len().min(CHUNK);
            while cut > 0 && !rest.is_char_boundary(cut) {
                cut -= 1;
            }
            let (head, tail) = rest.split_at(cut);
            // An interior NUL is the one thing CString refuses; say so rather than dropping the line.
            let line = CString::new(head).unwrap_or_else(|_| {
                CString::new("<panic text contained a NUL byte>").expect("literal has no NUL")
            });
            unsafe { __android_log_write(prio, tag, line.as_ptr()) };
            if tail.is_empty() {
                return;
            }
            rest = tail;
        }
    }

    /// `VmRSS`/`VmHWM` in kB, read from `/proc/self/status` so no page size is assumed, plus the
    /// kernel's own `MemAvailable`. Absent fields are reported as absent, never as zero.
    pub fn memory() -> String {
        fn field(text: &str, key: &str) -> String {
            text.lines()
                .find(|l| l.starts_with(key))
                .and_then(|l| l.split_whitespace().nth(1))
                .map(|kb| kb.to_string())
                .unwrap_or_else(|| "?".to_string())
        }
        let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
        let meminfo = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
        format!(
            "rss={} kB peak={} kB avail={} kB",
            field(&status, "VmRSS:"),
            field(&status, "VmHWM:"),
            field(&meminfo, "MemAvailable:")
        )
    }

    pub fn note(what: &str) {
        emit(PRIO_INFO, &format!("{what} — {}", memory()));
    }

    static INSTALLED: Once = Once::new();

    pub fn install() {
        INSTALLED.call_once(|| {
            let previous = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                let where_ = info
                    .location()
                    .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                    .unwrap_or_else(|| "<unknown location>".to_string());
                let what = info
                    .payload()
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_string())
                    .or_else(|| info.payload().downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "<non-string panic payload>".to_string());
                emit(
                    PRIO_ERROR,
                    &format!("PANIC at {where_}: {what} — {}", memory()),
                );
                emit(
                    PRIO_ERROR,
                    &format!("backtrace:\n{}", Backtrace::force_capture()),
                );
                previous(info);
            }));
            note("panic hook installed");
        });
    }
}

#[cfg(not(target_os = "android"))]
mod imp {
    pub fn install() {}
    pub fn note(_what: &str) {}
}

/// Route Rust panics to logcat before the JNI boundary aborts the process. Idempotent; called from
/// `JNI_OnLoad`, so every export is covered without touching each one.
pub fn install() {
    imp::install();
}

/// One logcat line, tagged with the process's resident size — the memory reading around an
/// expensive native step, so an abort under pressure is distinguishable from one that is not.
pub fn note(what: &str) {
    imp::note(what);
}
