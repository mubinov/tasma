//! `POST /app/files/open`, which opens a file in the app that the link
//! settings choose, and `POST /app/files/reveal`, which shows a file in Finder.
//! Neither route runs a file.

use std::ffi::CString;
use std::fs::Metadata;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::ptr::NonNull;
use std::sync::mpsc;

use objc2::rc::{Retained, autoreleasepool};
use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSArray, NSBundle, NSNumber, NSURL, NSURLIsAliasFileKey};
use serde_json::Value;
use tauri::http::{Method, Response, StatusCode};
use tauri::{AppHandle, Runtime, Url};

use crate::apps::{self, App};
use crate::browsers;
use crate::editors::{self, Selected};
use crate::external;
use crate::links;
use crate::log;
use crate::update::plain;

/// The routes under `/app`. Held to `OPEN_FILE_ROUTE` and `REVEAL_FILE_ROUTE`
/// in `apps/web` by a repo test.
pub(crate) const OPEN_PATH: &str = "/files/open";
pub(crate) const REVEAL_PATH: &str = "/files/reveal";

const PREFIX: &str = "/files";

const NOT_OPENED: &str = "a file could not be opened";
const NO_ANSWER: &str = "the open gave no answer";

/// Extensions of files that the default app of their type runs, installs or
/// forwards to a target.
const RUNS_EXTENSIONS: [&str; 28] = [
    "app",
    "command",
    "fileloc",
    "inetloc",
    "jar",
    "jnlp",
    "mobileconfig",
    "mpkg",
    "pkg",
    "prefpane",
    "terminal",
    "tool",
    "webloc",
    "workflow",
    // Windows, for Wine, CrossOver, Parallels and similar apps.
    "bat",
    "cmd",
    "com",
    "exe",
    "lnk",
    "msi",
    "ps1",
    "scr",
    "vbs",
    // Projects whose app can run project code when it opens them: game
    // engines, RStudio and MATLAB.
    "godot",
    "unity",
    "uproject",
    "rproj",
    "prj",
];

/// Default apps that run, install or forward the file they open. Finder opens
/// the target of a location file.
pub(crate) const RUNNER_APPS: [&str; 16] = [
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "dev.warp.Warp-Stable",
    "com.mitchellh.ghostty",
    "net.kovidgoyal.kitty",
    "org.alacritty",
    "com.github.wez.wezterm",
    "co.zeit.hyper",
    "org.python.PythonLauncher",
    "com.apple.JavaLauncher",
    "com.codeweavers.CrossOver",
    "com.apple.installer",
    "com.apple.AutomatorInstaller",
    "com.apple.Automator",
    "com.apple.systempreferences",
    "com.apple.finder",
];

#[derive(Debug, PartialEq, Eq)]
enum Request {
    Open(PathBuf, Option<u64>),
    Reveal(PathBuf),
}

/// What the route read about a resolved path.
#[derive(Clone, Copy, Debug)]
struct File {
    regular: bool,
    mode: u32,
    alias: bool,
    /// Whether no other account can replace the path between the checks and
    /// the open.
    guarded: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum Action {
    /// Opens the link in the app: the selected editor or the default app.
    Open(Url, App),
    Reveal,
}

pub(crate) fn handles(path: &str) -> bool {
    path.strip_prefix(PREFIX)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

/// The request, or the status that refuses it.
fn read(method: &Method, path: &str, body: &[u8]) -> Result<Request, StatusCode> {
    let open = match path {
        OPEN_PATH => true,
        REVEAL_PATH => false,
        _ => return Err(StatusCode::NOT_FOUND),
    };

    if *method != Method::POST {
        return Err(StatusCode::METHOD_NOT_ALLOWED);
    }

    let Ok(Value::Object(fields)) = serde_json::from_slice(body) else {
        return Err(StatusCode::BAD_REQUEST);
    };
    let Some(Value::String(file)) = fields.get("path") else {
        return Err(StatusCode::BAD_REQUEST);
    };
    let line = match fields.get("line") {
        Some(line) if open => Some(
            line.as_u64()
                .filter(|line| *line >= 1)
                .ok_or(StatusCode::BAD_REQUEST)?,
        ),
        _ => None,
    };

    let file = PathBuf::from(file);
    if !file.is_absolute() {
        return Err(StatusCode::BAD_REQUEST);
    }

    Ok(if open {
        Request::Open(file, line)
    } else {
        Request::Reveal(file)
    })
}

/// Whether the default app of a file can run it, from its resolved path, its
/// mode and the bundle id of its default app.
fn may_run(path: &str, mode: u32, default_app: &str) -> bool {
    let name = path.rsplit_once('/').map_or(path, |(_, name)| name);
    let name = name.to_lowercase();

    mode & 0o111 != 0
        || name
            .rsplit_once('.')
            .is_some_and(|(_, extension)| RUNS_EXTENSIONS.contains(&extension))
        // Xcode runs the manifest of a Swift package it opens.
        || name == "package.swift"
        || (name.starts_with("package@swift-") && name.ends_with(".swift"))
        || RUNNER_APPS.contains(&default_app)
}

/// What the open route does with a resolved path. `default_app` gives the
/// default app of the file, or `None` when it has none in macOS or in an
/// Applications folder.
fn action(
    resolved: &Path,
    file: File,
    line: Option<u64>,
    editor: Option<&Selected>,
    default_app: impl FnOnce() -> Option<App>,
) -> Action {
    // An editor can read a path that breaks the editor path rule as another
    // path, and opens a `.code-workspace` file as a workspace.
    let path = match resolved.to_str() {
        Some(path)
            if file.regular && !file.alias && file.guarded && external::is_editor_path(path) =>
        {
            path
        }
        _ => return Action::Reveal,
    };

    if let Some(editor) = editor {
        return editor.link(path, line).map_or(Action::Reveal, |link| {
            Action::Open(link, editor.app.clone())
        });
    }

    match default_app() {
        Some(app) if !may_run(path, file.mode, &app.id) => {
            Url::from_file_path(path).map_or(Action::Reveal, |link| Action::Open(link, app))
        }
        _ => Action::Reveal,
    }
}

/// The resolved path and what it is, or `None` when it cannot be resolved.
fn resolve(path: &Path) -> Option<(PathBuf, Metadata)> {
    let resolved = std::fs::canonicalize(path).ok()?;
    let stats = std::fs::metadata(&resolved).ok()?;

    Some((resolved, stats))
}

/// The file URL of a resolved path, from its bytes, which need not be UTF-8.
fn file_url(path: &Path, folder: bool) -> Retained<NSURL> {
    let bytes =
        CString::new(path.as_os_str().as_bytes()).expect("a resolved path holds no NUL byte");

    // Safety: `bytes` ends in NUL and outlives the call.
    unsafe {
        NSURL::fileURLWithFileSystemRepresentation_isDirectory_relativeToURL(
            NonNull::from(bytes.as_c_str()).cast(),
            folder,
            None,
        )
    }
}

/// Whether the file is a Finder alias. A read that fails counts as one.
fn is_alias(target: &NSURL) -> bool {
    let mut value = None;
    // Safety: the key is a constant of Foundation, and the value is read as an
    // `NSNumber` only after a check.
    let read = unsafe { target.getResourceValue_forKey_error(&mut value, NSURLIsAliasFileKey) };

    read.ok()
        .and(value)
        .and_then(|value| value.downcast::<NSNumber>().ok())
        .is_none_or(|alias| alias.boolValue())
}

/// The default app of a file, when it is installed in macOS or in an
/// Applications folder.
fn default_app(target: &NSURL) -> Option<App> {
    let app = NSWorkspace::sharedWorkspace().URLForApplicationToOpenURL(target)?;
    let path = apps::installed_at(&app)?;
    let id = NSBundle::bundleWithURL(&app).and_then(|bundle| browsers::bundle_id(&bundle))?;

    Some(App { id, path })
}

/// The log line of a file that `app` did not open.
fn not_opened(resolved: &Path, app: &App, cause: &str) -> String {
    format!(
        "{NOT_OPENED} in {}: {}: {}",
        log::quoted(&app.id),
        log::quoted(&resolved.to_string_lossy()),
        log::quoted(cause)
    )
}

/// The status of a request, or the log line of an open that failed. `reveal`
/// shows the file in Finder, and `open` opens a link in an app.
fn run(
    request: Request,
    file_app: &str,
    reveal: impl FnOnce(&NSURL),
    open: impl FnOnce(&Url, &App) -> Result<(), String>,
) -> Result<StatusCode, String> {
    let (Request::Open(path, _) | Request::Reveal(path)) = &request;
    let Some((resolved, stats)) = resolve(path) else {
        return Ok(StatusCode::NOT_FOUND);
    };

    // A blocking thread of the async runtime has no autorelease pool.
    autoreleasepool(|_| {
        let target = file_url(&resolved, stats.is_dir());
        let chosen = match request {
            Request::Reveal(_) => Action::Reveal,
            Request::Open(_, line) => {
                // Safety: `getuid` reads the calling process and changes nothing.
                let me = unsafe { libc::getuid() };
                let file = File {
                    regular: stats.is_file(),
                    mode: stats.mode(),
                    alias: is_alias(&target),
                    guarded: external::is_guarded(&resolved, me),
                };
                let editor = editors::selected(file_app);

                action(&resolved, file, line, editor.as_ref(), || {
                    default_app(&target)
                })
            }
        };

        match chosen {
            Action::Reveal => {
                reveal(&target);
                Ok(StatusCode::NO_CONTENT)
            }
            Action::Open(link, app) => open(&link, &app)
                .map(|()| StatusCode::NO_CONTENT)
                .map_err(|cause| not_opened(&resolved, &app, &cause)),
        }
    })
}

fn reveal(target: &NSURL) {
    NSWorkspace::sharedWorkspace().activateFileViewerSelectingURLs(&NSArray::from_slice(&[target]));
}

/// Opens `link` in the bundle at the checked path of `app`, never in an app
/// that Launch Services looks up again.
fn open(link: &Url, app: &App) -> Result<(), String> {
    let (sender, receiver) = mpsc::channel();
    external::open_in(link, &file_url(&app.path, true), move |result| {
        let _ = sender.send(result);
    });

    receiver
        .recv()
        .unwrap_or_else(|_| Err(NO_ANSWER.to_string()))
}

/// `POST /app/files/open` and `POST /app/files/reveal`. The answer of an open
/// comes once the app has the file.
pub(crate) async fn serve<R: Runtime>(
    app: &AppHandle<R>,
    method: &Method,
    path: &str,
    body: &[u8],
) -> Response<Vec<u8>> {
    let request = match read(method, path, body) {
        Ok(request) => request,
        Err(status) => return plain(status),
    };
    let file_app = links::settings(app).file_app;

    // Off the async runtime's workers, so a file on a volume that hangs, or an
    // editor that starts slowly, holds none.
    let answer =
        tauri::async_runtime::spawn_blocking(move || run(request, &file_app, reveal, open))
            .await
            .unwrap_or(Ok(StatusCode::INTERNAL_SERVER_ERROR));

    match answer {
        Ok(status) => plain(status),
        Err(line) => {
            external::note(&line);
            plain(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::ffi::OsStr;
    use std::os::unix::fs::PermissionsExt;

    use objc2_foundation::{NSString, NSURLBookmarkCreationOptions};
    use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
    use serde_json::json;
    use tauri::Manager as _;

    use super::*;
    use crate::editors::Form;
    use crate::testing::directory;

    const LINE: Option<u64> = Some(42);
    const VIEWER: &str = "com.example.viewer";
    const EDITOR: &str = "com.example.editor";

    fn served(method: Method, path: &str, body: &[u8]) -> StatusCode {
        let app = tauri::test::mock_app();
        app.manage(links::Links::default());

        tauri::async_runtime::block_on(serve(app.handle(), &method, path, body)).status()
    }

    fn body(path: &str) -> Vec<u8> {
        json!({ "path": path }).to_string().into_bytes()
    }

    const fn regular(mode: u32) -> File {
        File {
            regular: true,
            mode,
            alias: false,
            guarded: true,
        }
    }

    const FOLDER: File = File {
        regular: false,
        ..regular(0o755)
    };

    const ALIAS: File = File {
        alias: true,
        ..regular(0o644)
    };

    const UNGUARDED: File = File {
        guarded: false,
        ..regular(0o644)
    };

    fn app(id: &str) -> App {
        App {
            id: id.to_string(),
            path: PathBuf::from("/Applications/Example.app"),
        }
    }

    fn editor(form: Option<Form>) -> Selected {
        Selected {
            app: app(EDITOR),
            form,
        }
    }

    fn vscode() -> Selected {
        editor(Some(Form::File("vscode")))
    }

    fn url(text: &str) -> Url {
        text.parse().unwrap()
    }

    /// The action for `path`, with a default app that is `VIEWER`.
    fn decided(path: &str, file: File, editor: Option<&Selected>) -> Action {
        action(Path::new(path), file, LINE, editor, || Some(app(VIEWER)))
    }

    /// What `run` handed to macOS.
    #[derive(Debug, PartialEq, Eq)]
    enum Handed {
        Shown(String),
        Opened(Url, App),
    }

    /// The answer of `run` with an open that answers `result`, and what it
    /// handed to macOS.
    fn ran(
        request: Request,
        file_app: &str,
        result: Result<(), String>,
    ) -> (Result<StatusCode, String>, Option<Handed>) {
        let handed = RefCell::new(None);
        let answer = run(
            request,
            file_app,
            |target| {
                let path = target.path().unwrap().to_string();
                handed.replace(Some(Handed::Shown(path)));
            },
            |link, app| {
                handed.replace(Some(Handed::Opened(link.clone(), app.clone())));
                result
            },
        );

        (answer, handed.into_inner())
    }

    /// The default app of `path` as `action` gets it.
    fn default_app_of(path: &Path) -> App {
        autoreleasepool(|_| default_app(&file_url(path, false)))
            .expect("the file has a default app")
    }

    fn real(path: &Path) -> String {
        std::fs::canonicalize(path)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string()
    }

    fn write(path: &Path, mode: u32) {
        std::fs::write(path, "").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    /// A Finder alias at `alias` to `target`.
    fn make_alias(target: &Path, alias: &Path) {
        let target = NSURL::fileURLWithPath(&NSString::from_str(target.to_str().unwrap()));
        let alias = NSURL::fileURLWithPath(&NSString::from_str(alias.to_str().unwrap()));
        let data = target
            .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                NSURLBookmarkCreationOptions::SuitableForBookmarkFile,
                None,
                None,
            )
            .unwrap();

        NSURL::writeBookmarkData_toURL_options_error(&data, &alias, 0).unwrap();
    }

    #[test]
    fn the_files_routes_are_a_whole_segment() {
        assert!(handles("/files"));
        assert!(handles("/files/open"));
        assert!(!handles("/filesx"));
        assert!(!handles("/editors"));
    }

    #[test]
    fn another_path_under_the_routes_is_not_found() {
        for path in ["/files", "/files/x", "/files/open/x", "/files/reveal/"] {
            assert_eq!(
                served(Method::POST, path, &body("/x/a.ts")),
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
    }

    #[test]
    fn a_method_other_than_post_is_not_allowed() {
        for path in [OPEN_PATH, REVEAL_PATH] {
            for method in [Method::GET, Method::PUT, Method::DELETE] {
                assert_eq!(
                    served(method.clone(), path, &body("/x/a.ts")),
                    StatusCode::METHOD_NOT_ALLOWED,
                    "{method} {path}"
                );
            }
        }
    }

    #[test]
    fn a_body_that_names_no_absolute_path_is_a_bad_request() {
        for path in [OPEN_PATH, REVEAL_PATH] {
            for sent in [
                "{path".to_string(),
                String::new(),
                "[]".to_string(),
                "null".to_string(),
                json!(["/x/a.ts"]).to_string(),
                json!({}).to_string(),
                json!({ "path": 7 }).to_string(),
                json!({ "path": null }).to_string(),
                json!({ "path": "a.ts" }).to_string(),
                json!({ "path": "./a.ts" }).to_string(),
                json!({ "path": "~/a.ts" }).to_string(),
                json!({ "path": "" }).to_string(),
            ] {
                assert_eq!(
                    served(Method::POST, path, sent.as_bytes()),
                    StatusCode::BAD_REQUEST,
                    "{path} {sent}"
                );
            }
        }
    }

    #[test]
    fn an_open_with_a_line_that_is_no_positive_integer_is_a_bad_request() {
        for line in [json!(0), json!(-1), json!(1.5), json!("42"), Value::Null] {
            let sent = json!({ "path": "/x/a.ts", "line": line }).to_string();

            assert_eq!(
                served(Method::POST, OPEN_PATH, sent.as_bytes()),
                StatusCode::BAD_REQUEST,
                "{line}"
            );
        }
    }

    #[test]
    fn a_request_reads_its_path_and_the_line_of_an_open() {
        let sent = json!({ "path": "/x/a.ts", "line": 42, "other": true }).to_string();

        assert_eq!(
            read(&Method::POST, OPEN_PATH, sent.as_bytes()),
            Ok(Request::Open(PathBuf::from("/x/a.ts"), LINE))
        );
        assert_eq!(
            read(&Method::POST, OPEN_PATH, &body("/x/a.ts")),
            Ok(Request::Open(PathBuf::from("/x/a.ts"), None))
        );
        assert_eq!(
            read(&Method::POST, REVEAL_PATH, sent.as_bytes()),
            Ok(Request::Reveal(PathBuf::from("/x/a.ts")))
        );
    }

    #[test]
    fn a_path_that_cannot_be_resolved_is_not_found() {
        let directory = directory("files-not-found");
        std::os::unix::fs::symlink(directory.join("missing"), directory.join("broken")).unwrap();
        std::fs::write(directory.join("a.ts"), "").unwrap();

        for path in [
            directory.join("missing.ts"),
            directory.join("broken"),
            directory.join("a.ts/b.ts"),
        ] {
            for route in [OPEN_PATH, REVEAL_PATH] {
                assert_eq!(
                    served(Method::POST, route, &body(path.to_str().unwrap())),
                    StatusCode::NOT_FOUND,
                    "{route} {}",
                    path.display()
                );
            }
        }
    }

    #[test]
    fn a_reveal_shows_the_resolved_path_in_finder() {
        let directory = directory("files-reveal");
        std::fs::create_dir(directory.join("proj")).unwrap();
        std::fs::write(directory.join("proj/run.command"), "").unwrap();
        std::os::unix::fs::symlink(directory.join("proj"), directory.join("linked")).unwrap();

        for (sent, shown) in [
            ("linked/run.command", "proj/run.command"),
            ("linked", "proj"),
        ] {
            assert_eq!(
                ran(Request::Reveal(directory.join(sent)), "", Ok(())),
                (
                    Ok(StatusCode::NO_CONTENT),
                    Some(Handed::Shown(real(&directory.join(shown))))
                ),
                "{sent}"
            );
        }
    }

    #[test]
    fn an_open_with_no_editor_opens_a_text_file_in_its_default_app() {
        let directory = directory("files-default-app");
        let notes = directory.join("notes.txt");
        write(&notes, 0o644);

        let notes = real(&notes);

        // TextEdit opens a text file on every Mac.
        assert_eq!(
            ran(Request::Open(PathBuf::from(&notes), LINE), "", Ok(())),
            (
                Ok(StatusCode::NO_CONTENT),
                Some(Handed::Opened(
                    Url::from_file_path(&notes).unwrap(),
                    default_app_of(Path::new(&notes))
                ))
            )
        );
    }

    #[test]
    fn an_open_shows_in_finder_what_could_run() {
        let directory = directory("files-could-run");
        std::fs::create_dir(directory.join("proj")).unwrap();
        write(&directory.join("run.command"), 0o644);
        write(&directory.join("tool"), 0o755);
        write(&directory.join("team.code-workspace"), 0o644);
        std::os::unix::fs::symlink(directory.join("run.command"), directory.join("notes.txt"))
            .unwrap();
        make_alias(&directory.join("proj"), &directory.join("alias"));

        for (name, shown) in [
            ("proj", "proj"),
            ("run.command", "run.command"),
            ("tool", "tool"),
            ("team.code-workspace", "team.code-workspace"),
            ("notes.txt", "run.command"),
            ("alias", "alias"),
        ] {
            for file_app in ["", "com.apple.Terminal"] {
                assert_eq!(
                    ran(Request::Open(directory.join(name), None), file_app, Ok(())),
                    (
                        Ok(StatusCode::NO_CONTENT),
                        Some(Handed::Shown(real(&directory.join(shown))))
                    ),
                    "{name} {file_app}"
                );
            }
        }
    }

    #[test]
    fn an_open_shows_in_finder_a_file_that_another_account_can_replace() {
        let directory = directory("files-unguarded");
        let shared = directory.join("shared");
        std::fs::create_dir(&shared).unwrap();
        write(&shared.join("notes.txt"), 0o644);
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o777)).unwrap();

        assert_eq!(
            ran(Request::Open(shared.join("notes.txt"), None), "", Ok(())),
            (
                Ok(StatusCode::NO_CONTENT),
                Some(Handed::Shown(real(&shared.join("notes.txt"))))
            )
        );
    }

    #[test]
    fn a_file_that_the_default_app_does_not_open_is_a_failure_with_its_line() {
        let directory = directory("files-not-opened");
        let notes = directory.join("notes.txt");
        write(&notes, 0o644);
        let notes = real(&notes);
        let cause = "the app quit".to_string();

        assert_eq!(
            ran(
                Request::Open(PathBuf::from(&notes), None),
                "",
                Err(cause.clone())
            )
            .0,
            Err(not_opened(
                Path::new(&notes),
                &default_app_of(Path::new(&notes)),
                &cause
            ))
        );
    }

    #[test]
    fn a_file_not_opened_is_one_line_with_the_app_the_path_and_the_cause() {
        assert_eq!(
            not_opened(
                Path::new("/x/a b.ts"),
                &app("com.example.editor\n"),
                "the app quit\ntasma-app: forged"
            ),
            "a file could not be opened in com.example.editor\\u000a: /x/a b.ts: \
             the app quit\\u000atasma-app: forged"
        );
    }

    #[test]
    fn the_alias_read_tells_an_alias_from_a_regular_file() {
        let directory = directory("files-alias");
        std::fs::write(directory.join("a.ts"), "").unwrap();
        make_alias(&directory.join("a.ts"), &directory.join("alias"));
        let read = |name: &str| is_alias(&file_url(&directory.join(name), false));

        assert!(read("alias"));
        assert!(!read("a.ts"));
        assert!(read("missing"), "a read that fails counts as an alias");
    }

    #[test]
    fn the_file_url_of_a_path_keeps_its_bytes() {
        let path = Path::new(OsStr::from_bytes(b"/x/a\xff b.ts"));

        assert_eq!(
            file_url(path, false).absoluteString().unwrap().to_string(),
            "file:///x/a%FF%20b.ts"
        );
        assert_eq!(
            file_url(Path::new("/x/proj"), true)
                .absoluteString()
                .unwrap()
                .to_string(),
            "file:///x/proj/"
        );
    }

    #[test]
    fn a_file_may_run_by_its_mode() {
        for mode in [0o744, 0o755, 0o701] {
            assert!(may_run("/x/notes.txt", mode, VIEWER), "{mode:o}");
        }
    }

    #[test]
    fn a_file_may_run_by_its_extension_in_any_case() {
        for extension in RUNS_EXTENSIONS {
            let lower = format!("/x/run.{extension}");
            let upper = format!("/x/RUN.{}", extension.to_uppercase());
            let kelvin = format!("/x/run.{}", extension.replace('k', "\u{212a}"));

            for path in [lower, upper, kelvin] {
                assert!(may_run(&path, 0o644, VIEWER), "{path}");
            }
        }
        assert!(may_run("/x/.command", 0o644, VIEWER));
    }

    #[test]
    fn a_swift_package_manifest_may_run() {
        for name in ["Package.swift", "package.swift", "Package@swift-5.9.swift"] {
            assert!(may_run(&format!("/x/{name}"), 0o644, VIEWER), "{name}");
        }
    }

    #[test]
    fn a_file_may_run_by_its_default_app() {
        for id in RUNNER_APPS {
            assert!(may_run("/x/notes.txt", 0o644, id), "{id}");
        }
    }

    #[test]
    fn a_project_whose_app_can_run_project_code_may_run() {
        for name in ["analysis.Rproj", "model.prj"] {
            assert!(may_run(&format!("/x/{name}"), 0o644, VIEWER), "{name}");
        }
    }

    #[test]
    fn a_text_file_with_a_viewer_does_not_run() {
        assert!(!may_run("/x/notes.txt", 0o644, VIEWER));
        assert!(!may_run("/x/Package.swift.txt", 0o644, VIEWER));
    }

    #[test]
    fn a_folder_an_alias_or_a_file_that_another_account_can_replace_is_shown() {
        for file in [FOLDER, ALIAS, UNGUARDED] {
            for editor in [None, Some(&vscode())] {
                let decided = action(Path::new("/x/proj"), file, LINE, editor, || {
                    unreachable!("the default app is not looked up")
                });

                assert_eq!(decided, Action::Reveal, "{file:?} {editor:?}");
            }
        }
    }

    #[test]
    fn a_path_that_is_not_utf8_is_shown() {
        let path = Path::new(OsStr::from_bytes(b"/x/a\xff.ts"));

        for editor in [None, Some(&vscode())] {
            assert_eq!(
                action(path, regular(0o644), LINE, editor, || Some(app(VIEWER))),
                Action::Reveal,
                "{editor:?}"
            );
        }
    }

    #[test]
    fn a_path_that_an_editor_can_read_in_another_way_is_shown() {
        for path in [
            "/x/proj:",
            "/x/a:3",
            "/x/notes (copy)",
            "/x/a.ts ",
            "/x/team.code-workspace",
            "/x/team.CODE-WORKSPACE",
        ] {
            for editor in [None, Some(&vscode())] {
                assert_eq!(
                    decided(path, regular(0o644), editor),
                    Action::Reveal,
                    "{path} {editor:?}"
                );
            }
        }
    }

    #[test]
    fn with_an_editor_each_regular_file_opens_in_it() {
        let directory = real(&directory("files-in-editor"));

        for (name, mode) in [
            ("a.ts", 0o644),
            ("run.command", 0o644),
            ("Package.swift", 0o644),
            ("tool.sh", 0o755),
        ] {
            let path = format!("{directory}/{name}");

            assert_eq!(
                decided(&path, regular(mode), Some(&vscode())),
                Action::Open(url(&format!("vscode://file{path}:42")), app(EDITOR)),
                "{name}"
            );
        }
    }

    #[test]
    fn with_no_editor_a_file_opens_in_its_default_app_unless_it_may_run() {
        assert_eq!(
            decided("/x/notes.txt", regular(0o644), None),
            Action::Open(url("file:///x/notes.txt"), app(VIEWER))
        );
        assert_eq!(
            decided("/x/run.command", regular(0o644), None),
            Action::Reveal
        );
    }

    #[test]
    fn with_no_editor_a_file_with_no_accepted_default_app_is_shown() {
        assert_eq!(
            action(
                Path::new("/x/notes.txt"),
                regular(0o644),
                LINE,
                None,
                || None
            ),
            Action::Reveal
        );
    }

    #[test]
    fn a_file_form_link_drops_the_line_when_an_entry_has_the_path_with_the_line() {
        let directory = real(&directory("files-whole-path"));
        std::fs::create_dir(format!("{directory}/a.ts:42")).unwrap();
        let path = format!("{directory}/a.ts");

        for scheme in ["zed", "vscode"] {
            assert_eq!(
                decided(
                    &path,
                    regular(0o644),
                    Some(&editor(Some(Form::File(scheme))))
                ),
                Action::Open(
                    url(&format!("{scheme}://file{directory}/a.ts")),
                    app(EDITOR)
                ),
                "{scheme}"
            );
        }
    }

    #[test]
    fn the_editor_link_is_in_the_form_of_the_editor() {
        let directory = real(&directory("files-editor-link"));
        let path = format!("{directory}/a b#c.ts");
        let encoded = utf8_percent_encode(&directory, NON_ALPHANUMERIC);

        for (form, line, link) in [
            (
                Some(Form::File("vscode")),
                LINE,
                format!("vscode://file{directory}/a%20b%23c.ts:42"),
            ),
            (
                Some(Form::Open("webstorm")),
                LINE,
                format!("webstorm://open?file={encoded}%2Fa%20b%23c%2Ets&line=42"),
            ),
            (None, LINE, format!("file://{directory}/a%20b%23c.ts")),
            (
                Some(Form::File("vscode")),
                None,
                format!("file://{directory}/a%20b%23c.ts"),
            ),
            (
                Some(Form::Open("webstorm")),
                None,
                format!("file://{directory}/a%20b%23c.ts"),
            ),
        ] {
            assert_eq!(
                action(
                    Path::new(&path),
                    regular(0o644),
                    line,
                    Some(&editor(form)),
                    || { unreachable!("the default app is not looked up") }
                ),
                Action::Open(url(&link), app(EDITOR)),
                "{form:?} {line:?}"
            );
        }
    }
}
