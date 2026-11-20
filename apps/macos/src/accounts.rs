//! The macOS accounts and groups that can act as root.

pub(crate) const ROOT: u32 = 0;

/// The groups `wheel` and `admin`, whose members can act as root already.
pub(crate) const ADMINISTRATORS: [u32; 2] = [0, 80];
