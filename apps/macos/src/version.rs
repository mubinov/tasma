//! A version as a release tag or a daemon states it.

use semver::Version;

/// A version with or without a leading `v`.
pub(crate) fn version_of(text: &str) -> Option<Version> {
    Version::parse(text.strip_prefix('v').unwrap_or(text)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_is_read_with_or_without_a_leading_v() {
        assert_eq!(version_of("v0.2.0"), Some(Version::new(0, 2, 0)));
        assert_eq!(version_of("0.1.1"), Some(Version::new(0, 1, 1)));
        assert_eq!(version_of("one"), None);
        assert_eq!(version_of("unstated"), None);
    }

    #[test]
    fn a_higher_version_is_an_update_and_an_equal_or_lower_one_is_not() {
        let current = Version::new(0, 1, 0);

        assert!(version_of("v0.2.0").unwrap() > current);
        assert!(version_of("0.1.1").unwrap() > current);
        assert!(version_of("v0.1.0").unwrap() <= current);
        assert!(version_of("v0.0.9").unwrap() <= current);
        assert!(version_of("v0.1.0-beta.1").unwrap() <= current);
    }
}
