//! The code editors a file can open in, and `GET /app/editors`.

use std::path::{Path, PathBuf};

use objc2::rc::autoreleasepool;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Serialize;
use tauri::Url;
use tauri::http::{Method, Response, StatusCode};

use crate::apps::{self, App};
use crate::browsers;
use crate::external;
use crate::update::{json, plain};

/// The route under `/app`. Held to `EDITORS_ROUTE` in `apps/web` by a repo test.
pub(crate) const PATH: &str = "/editors";

/// How an editor reads a line from a link.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Form {
    /// `<scheme>://file<path>:<line>`
    File(&'static str),
    /// `<scheme>://open?file=<path>&line=<line>`
    Open(&'static str),
}

impl Form {
    fn scheme(self) -> &'static str {
        match self {
            Form::File(scheme) | Form::Open(scheme) => scheme,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Editor {
    /// The bundle id.
    id: &'static str,
    form: Option<Form>,
}

/// Code editors that do not run a file when they open it. An app that runs a
/// project file it opens, as Xcode runs `Package.swift`, never goes in.
static EDITORS: [Editor; 22] = [
    Editor {
        id: "com.microsoft.VSCode",
        form: Some(Form::File("vscode")),
    },
    Editor {
        id: "com.microsoft.VSCodeInsiders",
        form: Some(Form::File("vscode-insiders")),
    },
    Editor {
        id: "com.vscodium",
        form: Some(Form::File("vscodium")),
    },
    Editor {
        id: "com.todesktop.230313mzl4w4u92",
        form: Some(Form::File("cursor")),
    },
    Editor {
        id: "com.jetbrains.intellij",
        form: Some(Form::Open("idea")),
    },
    Editor {
        id: "com.jetbrains.intellij.ce",
        form: Some(Form::Open("idea")),
    },
    Editor {
        id: "com.jetbrains.WebStorm",
        form: Some(Form::Open("webstorm")),
    },
    Editor {
        id: "com.jetbrains.PhpStorm",
        form: Some(Form::Open("phpstorm")),
    },
    Editor {
        id: "com.jetbrains.pycharm",
        form: Some(Form::Open("pycharm")),
    },
    Editor {
        id: "com.jetbrains.pycharm.ce",
        form: Some(Form::Open("pycharm")),
    },
    Editor {
        id: "com.jetbrains.goland",
        form: Some(Form::Open("goland")),
    },
    Editor {
        id: "com.jetbrains.rustrover",
        form: Some(Form::Open("rustrover")),
    },
    Editor {
        id: "com.jetbrains.CLion",
        form: Some(Form::Open("clion")),
    },
    Editor {
        id: "com.jetbrains.rubymine",
        form: Some(Form::Open("rubymine")),
    },
    Editor {
        id: "com.jetbrains.rider",
        form: Some(Form::Open("rider")),
    },
    Editor {
        id: "dev.zed.Zed",
        form: Some(Form::File("zed")),
    },
    Editor {
        id: "com.sublimetext.4",
        form: None,
    },
    Editor {
        id: "com.sublimetext.3",
        form: None,
    },
    Editor {
        id: "com.panic.Nova",
        form: None,
    },
    Editor {
        id: "com.barebones.bbedit",
        form: None,
    },
    Editor {
        id: "com.macromates.TextMate",
        form: None,
    },
    Editor {
        id: "com.coteditor.CotEditor",
        form: None,
    },
];

/// The editor of the list with the bundle id `id`.
fn known(id: &str) -> Option<&'static Editor> {
    EDITORS.iter().find(|editor| editor.id == id)
}

/// The editor that the link settings select. `form` is `None` when the
/// installed app does not declare the scheme of its form.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Selected {
    pub(crate) app: App,
    pub(crate) form: Option<Form>,
}

impl Selected {
    /// The link that opens `path` in the editor, at `line` when the editor
    /// reads one. `path` is the real path of a guarded regular file that passes
    /// `external::is_editor_path`.
    pub(crate) fn link(&self, path: &str, line: Option<u64>) -> Option<Url> {
        match (self.form, line) {
            (Some(Form::File(scheme)), Some(line)) => {
                external::file_link(scheme, path, &format!(":{line}"))
            }
            (Some(Form::Open(scheme)), Some(line)) => Url::parse(&format!(
                "{scheme}://open?file={}&line={line}",
                utf8_percent_encode(path, NON_ALPHANUMERIC)
            ))
            .ok(),
            _ => Url::from_file_path(path).ok(),
        }
    }
}

/// Whether an `Info.plist` declares the URL scheme `scheme`.
fn declares(info: &plist::Value, scheme: &str) -> bool {
    fn list<'a>(value: &'a plist::Value, key: &str) -> Option<&'a Vec<plist::Value>> {
        value.as_dictionary()?.get(key)?.as_array()
    }

    list(info, "CFBundleURLTypes")
        .into_iter()
        .flatten()
        .filter_map(|entry| list(entry, "CFBundleURLSchemes"))
        .flatten()
        .any(|name| {
            name.as_string()
                .is_some_and(|name| name.eq_ignore_ascii_case(scheme))
        })
}

/// Whether the app bundle at `app` declares the URL scheme `scheme`.
fn declared(app: &Path, scheme: &str) -> bool {
    plist::Value::from_file(app.join("Contents/Info.plist"))
        .is_ok_and(|info| declares(&info, scheme))
}

/// `editor`, installed at `real`, with its form when the app declares its
/// scheme.
fn selection(editor: &Editor, real: PathBuf) -> Selected {
    Selected {
        form: editor.form.filter(|form| declared(&real, form.scheme())),
        app: App {
            id: editor.id.to_string(),
            path: real,
        },
    }
}

/// The editor of the link setting `file_app`, when it is in the list and
/// installed in macOS or in an Applications folder.
pub(crate) fn selected(file_app: &str) -> Option<Selected> {
    let editor = known(file_app)?;
    let (_, real) = apps::with_id(editor.id)?;

    Some(selection(editor, real))
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct Installed {
    id: &'static str,
    name: String,
}

/// Sorted by name in any case, then by id.
fn listed(mut entries: Vec<Installed>) -> Vec<Installed> {
    entries.sort_by(|one, other| {
        one.name
            .to_lowercase()
            .cmp(&other.name.to_lowercase())
            .then_with(|| one.id.cmp(other.id))
    });

    entries
}

/// The editors of the list that are installed in macOS or in an Applications
/// folder now.
fn installed() -> Vec<Installed> {
    // A worker thread of the async runtime has no autorelease pool.
    autoreleasepool(|_| {
        listed(
            EDITORS
                .iter()
                .filter_map(|editor| {
                    let (app, _) = apps::with_id(editor.id)?;
                    let (_, name) = browsers::app_of(&app);

                    Some(Installed {
                        id: editor.id,
                        name,
                    })
                })
                .collect(),
        )
    })
}

pub(crate) fn handles(path: &str) -> bool {
    path.strip_prefix(PATH)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

/// `GET /app/editors`.
pub(crate) fn serve(method: &Method, path: &str) -> Response<Vec<u8>> {
    if path != PATH {
        return plain(StatusCode::NOT_FOUND);
    }

    if *method != Method::GET {
        return plain(StatusCode::METHOD_NOT_ALLOWED);
    }

    json(&serde_json::json!(installed()))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use plist::{Dictionary, Value};
    use tauri::http::header::CONTENT_TYPE;

    use super::*;
    use crate::testing::directory;

    fn info(entries: Value) -> Value {
        Value::Dictionary(Dictionary::from_iter([(
            "CFBundleURLTypes".to_string(),
            entries,
        )]))
    }

    fn url_type(schemes: &[&str]) -> Value {
        Value::Dictionary(Dictionary::from_iter([
            (
                "CFBundleURLName".to_string(),
                Value::String("Example".to_string()),
            ),
            (
                "CFBundleURLSchemes".to_string(),
                Value::Array(
                    schemes
                        .iter()
                        .map(|scheme| Value::String(scheme.to_string()))
                        .collect(),
                ),
            ),
        ]))
    }

    fn installed_entry(id: &'static str, name: &str) -> Installed {
        Installed {
            id,
            name: name.to_string(),
        }
    }

    #[test]
    fn each_editor_of_the_list_is_known_by_its_id() {
        for editor in &EDITORS {
            assert_eq!(known(editor.id), Some(editor), "{}", editor.id);
        }
    }

    #[test]
    fn an_app_that_is_not_in_the_list_is_not_known() {
        for id in ["com.apple.Terminal", "com.example.not-an-editor", ""] {
            assert_eq!(known(id), None, "{id}");
        }
    }

    #[test]
    fn the_ids_are_unique_and_none_runs_files() {
        let ids: BTreeSet<&str> = EDITORS.iter().map(|editor| editor.id).collect();

        assert_eq!(ids.len(), EDITORS.len());
        for id in crate::files::RUNNER_APPS {
            assert!(!ids.contains(id), "{id}");
        }
    }

    #[test]
    fn an_info_plist_declares_a_scheme_that_one_of_its_url_types_lists() {
        let declared = info(Value::Array(vec![
            url_type(&["example-other"]),
            url_type(&["example-one", "webstorm", "example-two"]),
        ]));

        assert!(declares(&declared, "webstorm"));
        assert!(declares(
            &info(Value::Array(vec![url_type(&["WebStorm"])])),
            "webstorm"
        ));
    }

    #[test]
    fn an_info_plist_with_no_such_scheme_declares_none() {
        for value in [
            Value::Dictionary(Dictionary::new()),
            info(Value::Array(Vec::new())),
            info(Value::Array(vec![url_type(&["example-other"])])),
            info(Value::String("webstorm".to_string())),
            info(Value::Array(vec![Value::String("webstorm".to_string())])),
            info(Value::Array(vec![Value::Dictionary(
                Dictionary::from_iter([(
                    "CFBundleURLSchemes".to_string(),
                    Value::String("webstorm".to_string()),
                )]),
            )])),
            info(Value::Array(vec![Value::Dictionary(
                Dictionary::from_iter([(
                    "CFBundleURLSchemes".to_string(),
                    Value::Array(vec![Value::Integer(7.into())]),
                )]),
            )])),
            Value::String("webstorm".to_string()),
        ] {
            assert!(!declares(&value, "webstorm"), "{value:?}");
        }
    }

    #[test]
    fn an_editor_keeps_its_form_only_when_its_app_declares_the_scheme() {
        let directory = directory("editors-selection");
        let app = directory.join("Example.app");
        std::fs::create_dir_all(app.join("Contents")).unwrap();
        info(Value::Array(vec![url_type(&["webstorm", "zed"])]))
            .to_file_xml(app.join("Contents/Info.plist"))
            .unwrap();
        let missing = directory.join("Missing.app");

        for (id, at, form) in [
            ("com.jetbrains.WebStorm", &app, Some(Form::Open("webstorm"))),
            ("dev.zed.Zed", &app, Some(Form::File("zed"))),
            ("com.jetbrains.PhpStorm", &app, None),
            ("com.microsoft.VSCode", &app, None),
            ("com.jetbrains.WebStorm", &missing, None),
            ("com.sublimetext.4", &app, None),
        ] {
            assert_eq!(
                selection(known(id).unwrap(), at.clone()),
                Selected {
                    app: App {
                        id: id.to_string(),
                        path: at.clone()
                    },
                    form
                },
                "{id} {}",
                at.display()
            );
        }
    }

    #[test]
    fn an_editor_is_selected_only_when_it_is_installed() {
        let installed: Vec<&str> = installed().iter().map(|entry| entry.id).collect();

        autoreleasepool(|_| {
            for editor in &EDITORS {
                assert_eq!(
                    selected(editor.id).map(|selected| selected.app),
                    installed.contains(&editor.id).then(|| App {
                        id: editor.id.to_string(),
                        path: apps::with_id(editor.id).unwrap().1
                    }),
                    "{}",
                    editor.id
                );
            }
            assert_eq!(selected(""), None);
            assert_eq!(selected("com.apple.Terminal"), None);
        });
    }

    #[test]
    fn the_list_is_sorted_by_name_in_any_case_then_by_id() {
        assert_eq!(
            listed(vec![
                installed_entry("com.example.c", "beta"),
                installed_entry("com.example.b", "Alpha"),
                installed_entry("com.example.a", "alpha"),
            ]),
            vec![
                installed_entry("com.example.a", "alpha"),
                installed_entry("com.example.b", "Alpha"),
                installed_entry("com.example.c", "beta"),
            ]
        );
    }

    #[test]
    fn a_get_answers_the_installed_editors_of_the_list() {
        let answer = serve(&Method::GET, PATH);

        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(
            answer.headers().get(CONTENT_TYPE).unwrap(),
            "application/json"
        );
        let serde_json::Value::Array(entries) = serde_json::from_slice(answer.body()).unwrap()
        else {
            panic!("the answer is a JSON array");
        };
        for entry in entries {
            let id = entry["id"].as_str().expect("an id is a string");
            assert!(known(id).is_some(), "{entry}");
            assert!(entry["name"].is_string(), "{entry}");
            assert_eq!(entry.as_object().unwrap().len(), 2, "{entry}");
        }
    }

    #[test]
    fn another_method_is_not_allowed() {
        for method in [Method::POST, Method::PUT, Method::DELETE] {
            let answer = serve(&method, PATH);

            assert_eq!(answer.status(), StatusCode::METHOD_NOT_ALLOWED, "{method}");
            assert!(answer.body().is_empty());
        }
    }

    #[test]
    fn another_path_under_the_route_is_not_found() {
        for path in ["/editors/", "/editors/x"] {
            assert_eq!(
                serve(&Method::GET, path).status(),
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
    }

    #[test]
    fn the_route_is_a_whole_segment() {
        assert!(handles("/editors"));
        assert!(handles("/editors/x"));
        assert!(!handles("/editorsx"));
        assert!(!handles("/files"));
    }
}
