#![allow(unsafe_code)]

use super::Provider;
use std::{io, os::windows::ffi::OsStrExt as _, path::Path, ptr};
use windows_sys::Win32::{
    Foundation::ERROR_NOT_FOUND,
    Security::Credentials::{
        CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    },
};

fn target(provider: Provider) -> Vec<u16> {
    std::ffi::OsStr::new(&format!("rbxport/agent/{}", provider.id()))
        .encode_wide()
        .chain(Some(0))
        .collect()
}

pub(super) fn save(provider: Provider, key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 1024 || key.chars().any(char::is_control) {
        return Err("Enter a valid model API key.".into());
    }
    let mut target = target(provider);
    let mut blob = key.as_bytes().to_vec();
    let size = u32::try_from(blob.len()).map_err(|_| "The API key is too long.")?;
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_mut_ptr(),
        CredentialBlobSize: size,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        ..CREDENTIALW::default()
    };
    let written = unsafe { CredWriteW(&raw const credential, 0) };
    blob.fill(0);
    if written == 0 {
        return Err("Could not save the API key in Windows Credential Manager.".into());
    }
    Ok(())
}

fn read(provider: Provider) -> Result<Option<String>, String> {
    let target = target(provider);
    let mut raw = ptr::null_mut();
    let found = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &raw mut raw) };
    if found == 0 {
        if io::Error::last_os_error()
            .raw_os_error()
            .is_some_and(|code| code.cast_unsigned() == ERROR_NOT_FOUND)
        {
            return Ok(None);
        }
        return Err("Could not read the API key from Windows Credential Manager.".into());
    }
    let credential = unsafe { &*raw };
    let value = if credential.CredentialBlobSize == 0 || credential.CredentialBlob.is_null() {
        None
    } else {
        let bytes = unsafe {
            std::slice::from_raw_parts(
                credential.CredentialBlob,
                credential.CredentialBlobSize as usize,
            )
        };
        std::str::from_utf8(bytes).ok().map(str::to_owned)
    };
    unsafe { CredFree(raw.cast()) };
    Ok(value)
}

pub(super) fn load(provider: Provider) -> Result<String, String> {
    if let Some(key) = read(provider)? {
        return Ok(key);
    }
    if cfg!(debug_assertions) {
        if let Ok(key) = std::env::var(provider.key_name()) {
            if !key.trim().is_empty() {
                return Ok(key.trim().into());
            }
        }
        if provider == Provider::DeepSeek {
            let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.env.deepseek.local");
            if let Ok(content) = std::fs::read_to_string(file) {
                if let Some(key) = content.lines().find_map(|line| {
                    line.strip_prefix("DEEPSEEK_API_KEY=")
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                }) {
                    return Ok(key.into());
                }
            }
        }
    }
    Err("Enter an API key for this model provider.".into())
}
