//! One approved connection to the user's Chrome, shared by every card's agent.
//!
//! Chrome 144+ asks "Allow remote debugging?" for every new DevTools connection
//! and cannot be told to remember the answer. Each agent starts its own
//! chrome-devtools MCP, so each card used to raise the dialog again. Here the app
//! connects once — the only prompt — and serves that connection on a local
//! WebSocket the agents' MCP servers are pointed at instead.
//!
//! Clients are kept apart with flat CDP sessions: each one is given a browser
//! session of its own (`Target.attachToBrowserTarget`), its root-level messages
//! are sent on that session, and every reply and event is routed back by
//! request id or session id. To a client it looks like a browser to itself.

use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::{Message, WebSocket};

const POLL: Duration = Duration::from_millis(15);
/// How long the Allow dialog may sit before the attempt is given up.
const APPROVAL: Duration = Duration::from_secs(150);

type ClientId = u64;

enum Pending {
    Client(ClientId, Value),
    /// The browser session being opened for a newly connected client.
    Attach(ClientId),
    Ignore,
}

#[derive(Default)]
struct Client {
    tx: Option<Sender<String>>,
    /// The client's own browser session; messages are held until it exists.
    session: Option<String>,
    held: Vec<Value>,
}

#[derive(Default)]
struct Routes {
    clients: HashMap<ClientId, Client>,
    pending: HashMap<u64, Pending>,
    owners: HashMap<String, ClientId>,
}

struct Bridge {
    endpoint: String,
    chrome: Mutex<Option<Sender<String>>>,
    routes: Mutex<Routes>,
    next: AtomicU64,
}

static BRIDGE: OnceLock<Arc<Bridge>> = OnceLock::new();

/// The MCP config that points this run's `chrome-devtools` server at the shared
/// connection, as a `--mcp-config` value — or None when there is nothing to
/// share: no `chrome-devtools` server using `--autoConnect` is configured, or
/// Chrome's remote debugging is off. The agent then connects as it always did.
pub fn mcp_config(cwd: &Path) -> Option<String> {
    let home = crate::platform::home()?;
    let server = configured_server(&home.join(".claude.json"), cwd)?;
    chrome_endpoint()?;
    let bridge = start()?;
    let mut server = server;
    let args = server.get_mut("args")?.as_array_mut()?;
    args.retain(|arg| arg.as_str() != Some("--autoConnect"));
    args.push(json!("--wsEndpoint"));
    args.push(json!(bridge.endpoint));
    Some(json!({ "mcpServers": { "chrome-devtools": server } }).to_string())
}

/// The user's `chrome-devtools` server — project-local first, as the CLI picks —
/// when it attaches to the running Chrome rather than launching its own.
fn configured_server(config: &Path, cwd: &Path) -> Option<Value> {
    let config: Value = serde_json::from_str(&std::fs::read_to_string(config).ok()?).ok()?;
    let local = config
        .get("projects")
        .and_then(|projects| projects.get(cwd.to_string_lossy().as_ref()))
        .and_then(|project| project.pointer("/mcpServers/chrome-devtools"));
    let server = local.or_else(|| config.pointer("/mcpServers/chrome-devtools"))?.clone();
    let auto = server
        .get("args")?
        .as_array()?
        .iter()
        .any(|arg| arg.as_str() == Some("--autoConnect"));
    auto.then_some(server)
}

/// Where Chrome is listening, from the `DevToolsActivePort` file it writes into
/// its profile while remote debugging is on.
fn chrome_endpoint() -> Option<String> {
    profiles().into_iter().find_map(|dir| {
        let text = std::fs::read_to_string(dir.join("DevToolsActivePort")).ok()?;
        let mut lines = text.lines();
        let port: u16 = lines.next()?.trim().parse().ok()?;
        let path = lines.next()?.trim().to_string();
        // A stale file outlives Chrome; only a port that answers counts.
        TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(300))
            .ok()?;
        Some(format!("ws://127.0.0.1:{port}{path}"))
    })
}

fn profiles() -> Vec<PathBuf> {
    let Some(home) = crate::platform::home() else { return Vec::new() };
    if cfg!(target_os = "macos") {
        let root = home.join("Library/Application Support");
        ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Chromium"]
            .iter()
            .map(|dir| root.join(dir))
            .collect()
    } else if cfg!(windows) {
        let root = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or(home);
        [r"Google\Chrome\User Data", r"Google\Chrome Beta\User Data", r"Google\Chrome SxS\User Data", r"Chromium\User Data"]
            .iter()
            .map(|dir| root.join(dir))
            .collect()
    } else {
        let root = home.join(".config");
        ["google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium"]
            .iter()
            .map(|dir| root.join(dir))
            .collect()
    }
}

fn start() -> Option<Arc<Bridge>> {
    if let Some(bridge) = BRIDGE.get() {
        return Some(bridge.clone());
    }
    let listener = TcpListener::bind("127.0.0.1:0").ok()?;
    let port = listener.local_addr().ok()?.port();
    // Unguessable, so other local programs cannot ride the approved connection.
    let token = uuid::Uuid::new_v4().simple().to_string();
    let bridge = Arc::new(Bridge {
        endpoint: format!("ws://127.0.0.1:{port}/devtools/browser/{token}"),
        chrome: Mutex::new(None),
        routes: Mutex::new(Routes::default()),
        next: AtomicU64::new(1),
    });
    if BRIDGE.set(bridge.clone()).is_err() {
        return BRIDGE.get().cloned();
    }

    let path = format!("/devtools/browser/{token}");
    let serving = bridge.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let bridge = serving.clone();
            let path = path.clone();
            std::thread::spawn(move || serve_client(&bridge, stream, &path));
        }
    });
    // Connecting now raises the one dialog when the first card starts, rather
    // than when its agent first reaches for the browser.
    let connecting = bridge.clone();
    std::thread::spawn(move || {
        ensure_chrome(&connecting);
    });
    Some(bridge)
}

/// The shared connection, opened if it is not open. Only one attempt runs at a
/// time, so concurrent agents wait on the same dialog instead of raising more.
fn ensure_chrome(bridge: &Arc<Bridge>) -> Option<Sender<String>> {
    static CONNECTING: Mutex<()> = Mutex::new(());
    let _turn = CONNECTING.lock().ok()?;
    if let Some(tx) = bridge.chrome.lock().ok()?.clone() {
        return Some(tx);
    }

    let url = chrome_endpoint()?;
    let address = url.trim_start_matches("ws://").split('/').next()?.to_string();
    let stream = TcpStream::connect(&address).ok()?;
    stream.set_read_timeout(Some(APPROVAL)).ok()?;
    let (socket, _) = tungstenite::client(url.as_str(), stream).ok()?;
    socket.get_ref().set_read_timeout(Some(POLL)).ok()?;

    let (tx, rx) = mpsc::channel();
    *bridge.chrome.lock().ok()? = Some(tx.clone());
    let pumping = bridge.clone();
    std::thread::spawn(move || {
        pump(socket, rx, |text| from_chrome(&pumping, text));
        // Chrome went away: every client goes with it, and the next one to
        // arrive reconnects (which is when Chrome asks again).
        if let Ok(mut chrome) = pumping.chrome.lock() {
            *chrome = None;
        }
        if let Ok(mut routes) = pumping.routes.lock() {
            *routes = Routes::default();
        }
    });
    Some(tx)
}

/// Moves text both ways on one socket until it closes: incoming frames to
/// `deliver`, and whatever arrives on `outgoing` out to the socket.
fn pump(mut socket: WebSocket<TcpStream>, outgoing: Receiver<String>, mut deliver: impl FnMut(&str)) {
    loop {
        match socket.read() {
            Ok(Message::Text(text)) => deliver(text.as_str()),
            Ok(Message::Close(_)) => return,
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(_) => return,
        }
        loop {
            match outgoing.try_recv() {
                Ok(text) => {
                    if socket.send(Message::text(text)).is_err() {
                        return;
                    }
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    let _ = socket.close(None);
                    return;
                }
            }
        }
    }
}

fn serve_client(bridge: &Arc<Bridge>, stream: TcpStream, path: &str) {
    let check = |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
        if request.uri().path() == path {
            Ok(response)
        } else {
            let mut refused = ErrorResponse::new(None);
            *refused.status_mut() = tungstenite::http::StatusCode::NOT_FOUND;
            Err(refused)
        }
    };
    let Ok(socket) = tungstenite::accept_hdr(stream, check) else { return };
    if socket.get_ref().set_read_timeout(Some(POLL)).is_err() {
        return;
    }
    let Some(chrome) = ensure_chrome(bridge) else { return };

    let id = bridge.next.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    let attach = bridge.next.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut routes) = bridge.routes.lock() {
        routes.clients.insert(id, Client { tx: Some(tx), ..Client::default() });
        routes.pending.insert(attach, Pending::Attach(id));
    }
    let _ = chrome.send(json!({ "id": attach, "method": "Target.attachToBrowserTarget" }).to_string());

    pump(socket, rx, |text| from_client(bridge, id, text));

    let session = bridge.routes.lock().ok().and_then(|mut routes| {
        let client = routes.clients.remove(&id)?;
        routes.owners.retain(|_, owner| *owner != id);
        client.session
    });
    if let (Some(session), Some(chrome)) = (session, bridge.chrome.lock().ok().and_then(|c| c.clone())) {
        let detach = bridge.next.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut routes) = bridge.routes.lock() {
            routes.pending.insert(detach, Pending::Ignore);
        }
        let _ = chrome.send(
            json!({ "id": detach, "method": "Target.detachFromTarget", "params": { "sessionId": session } })
                .to_string(),
        );
    }
}

fn from_client(bridge: &Bridge, client: ClientId, text: &str) {
    let Ok(message) = serde_json::from_str::<Value>(text) else { return };
    let Ok(mut routes) = bridge.routes.lock() else { return };
    let Some(entry) = routes.clients.get_mut(&client) else { return };
    let Some(session) = entry.session.clone() else {
        entry.held.push(message);
        return;
    };
    let outgoing = rewrite_request(bridge, &mut routes, client, &session, message);
    drop(routes);
    send_chrome(bridge, outgoing);
}

/// Gives a client's request a bridge-wide id, remembering whose it was, and
/// puts root-level requests on the client's own browser session.
fn rewrite_request(
    bridge: &Bridge,
    routes: &mut Routes,
    client: ClientId,
    session: &str,
    mut message: Value,
) -> Option<String> {
    let object = message.as_object_mut()?;
    let original = object.get("id").cloned().unwrap_or(Value::Null);
    let id = bridge.next.fetch_add(1, Ordering::Relaxed);
    routes.pending.insert(id, Pending::Client(client, original));
    object.insert("id".into(), json!(id));
    object.entry("sessionId").or_insert_with(|| json!(session));
    Some(message.to_string())
}

fn send_chrome(bridge: &Bridge, text: Option<String>) {
    if let (Some(text), Some(chrome)) = (text, bridge.chrome.lock().ok().and_then(|c| c.clone())) {
        let _ = chrome.send(text);
    }
}

fn from_chrome(bridge: &Bridge, text: &str) {
    let Ok(mut message) = serde_json::from_str::<Value>(text) else { return };
    let Ok(mut routes) = bridge.routes.lock() else { return };

    if let Some(id) = message.get("id").and_then(Value::as_u64) {
        match routes.pending.remove(&id) {
            Some(Pending::Client(client, original)) => {
                if let Some(child) = message.pointer("/result/sessionId").and_then(Value::as_str) {
                    routes.owners.insert(child.to_string(), client);
                }
                message["id"] = original;
                deliver(&routes, client, message);
            }
            Some(Pending::Attach(client)) => {
                let Some(session) = message.pointer("/result/sessionId").and_then(Value::as_str) else {
                    // Refused: dropping the client closes its socket.
                    routes.clients.remove(&client);
                    return;
                };
                let session = session.to_string();
                routes.owners.insert(session.clone(), client);
                let held = routes
                    .clients
                    .get_mut(&client)
                    .map(|entry| {
                        entry.session = Some(session.clone());
                        std::mem::take(&mut entry.held)
                    })
                    .unwrap_or_default();
                let outgoing: Vec<_> = held
                    .into_iter()
                    .filter_map(|message| rewrite_request(bridge, &mut routes, client, &session, message))
                    .collect();
                drop(routes);
                for text in outgoing {
                    send_chrome(bridge, Some(text));
                }
            }
            Some(Pending::Ignore) | None => {}
        }
        return;
    }

    // An event belongs to whoever owns its session; the bridge's own root
    // connection subscribes to nothing, so an event without one is dropped.
    let Some(session) = message.get("sessionId").and_then(Value::as_str).map(str::to_string) else {
        return;
    };
    let Some(&client) = routes.owners.get(&session) else { return };
    match message.get("method").and_then(Value::as_str) {
        Some("Target.attachedToTarget") => {
            if let Some(child) = message.pointer("/params/sessionId").and_then(Value::as_str) {
                routes.owners.insert(child.to_string(), client);
            }
        }
        Some("Target.detachedFromTarget") => {
            if let Some(child) = message.pointer("/params/sessionId").and_then(Value::as_str) {
                routes.owners.remove(child);
            }
        }
        _ => {}
    }
    deliver(&routes, client, message);
}

/// Hands a message to its client, taking the client's own browser session off
/// it so root-level traffic looks to the client like a browser connection.
fn deliver(routes: &Routes, client: ClientId, mut message: Value) {
    let Some(entry) = routes.clients.get(&client) else { return };
    if let (Some(object), Some(session)) = (message.as_object_mut(), entry.session.as_deref()) {
        if object.get("sessionId").and_then(Value::as_str) == Some(session) {
            object.remove("sessionId");
        }
    }
    if let Some(tx) = &entry.tx {
        let _ = tx.send(message.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bridge() -> Bridge {
        Bridge {
            endpoint: String::new(),
            chrome: Mutex::new(None),
            routes: Mutex::new(Routes::default()),
            next: AtomicU64::new(100),
        }
    }

    fn client(bridge: &Bridge, id: ClientId, session: &str) -> Receiver<String> {
        let (tx, rx) = mpsc::channel();
        let mut routes = bridge.routes.lock().unwrap();
        routes.clients.insert(id, Client { tx: Some(tx), session: Some(session.into()), held: Vec::new() });
        routes.owners.insert(session.into(), id);
        rx
    }

    fn read(rx: &Receiver<String>) -> Value {
        serde_json::from_str(&rx.try_recv().expect("a message")).unwrap()
    }

    #[test]
    fn two_clients_share_one_connection_without_seeing_each_other() {
        let bridge = bridge();
        let (chrome_tx, chrome_rx) = mpsc::channel();
        *bridge.chrome.lock().unwrap() = Some(chrome_tx);
        let a = client(&bridge, 1, "browser-a");
        let b = client(&bridge, 2, "browser-b");

        // Both clients use id 1; the bridge keeps them apart.
        from_client(&bridge, 1, r#"{"id":1,"method":"Target.setDiscoverTargets"}"#);
        from_client(&bridge, 2, r#"{"id":1,"method":"Target.attachToTarget"}"#);
        let sent_a: Value = serde_json::from_str(&chrome_rx.try_recv().unwrap()).unwrap();
        let sent_b: Value = serde_json::from_str(&chrome_rx.try_recv().unwrap()).unwrap();
        assert_eq!(sent_a["sessionId"], "browser-a", "root requests go on the client's session");
        assert_ne!(sent_a["id"], sent_b["id"]);

        from_chrome(&bridge, &json!({ "id": sent_b["id"], "sessionId": "browser-b", "result": { "sessionId": "page-1" } }).to_string());
        let reply = read(&b);
        assert_eq!(reply["id"], 1, "the client's own id comes back");
        assert!(reply.get("sessionId").is_none(), "its browser session is invisible to it");
        assert!(a.try_recv().is_err(), "the other client hears nothing");

        // The page session B attached now routes to B alone.
        from_chrome(&bridge, r#"{"method":"Page.loadEventFired","sessionId":"page-1","params":{}}"#);
        assert_eq!(read(&b)["sessionId"], "page-1");
        assert!(a.try_recv().is_err());

        // Auto-attached children are owned by whoever's session announced them.
        from_chrome(&bridge, r#"{"method":"Target.attachedToTarget","sessionId":"browser-a","params":{"sessionId":"page-2"}}"#);
        assert_eq!(read(&a)["method"], "Target.attachedToTarget");
        from_chrome(&bridge, r#"{"method":"Runtime.consoleAPICalled","sessionId":"page-2","params":{}}"#);
        assert_eq!(read(&a)["sessionId"], "page-2");
        assert!(b.try_recv().is_err());

        from_chrome(&bridge, r#"{"method":"Target.targetCreated","params":{}}"#);
        assert!(a.try_recv().is_err() && b.try_recv().is_err(), "root-connection events are nobody's");
    }

    #[test]
    fn requests_wait_until_the_clients_session_exists() {
        let bridge = bridge();
        let (chrome_tx, chrome_rx) = mpsc::channel();
        *bridge.chrome.lock().unwrap() = Some(chrome_tx);
        let (tx, _rx) = mpsc::channel();
        bridge.routes.lock().unwrap().clients.insert(7, Client { tx: Some(tx), ..Client::default() });
        bridge.routes.lock().unwrap().pending.insert(50, Pending::Attach(7));

        from_client(&bridge, 7, r#"{"id":1,"method":"Browser.getVersion"}"#);
        assert!(chrome_rx.try_recv().is_err(), "held until attached");

        from_chrome(&bridge, r#"{"id":50,"result":{"sessionId":"browser-7"}}"#);
        let sent: Value = serde_json::from_str(&chrome_rx.try_recv().unwrap()).unwrap();
        assert_eq!(sent["method"], "Browser.getVersion");
        assert_eq!(sent["sessionId"], "browser-7");
    }

    #[test]
    fn only_an_auto_connecting_server_is_shared() {
        let dir = std::env::temp_dir().join(format!("agent-board-bridge-{}", crate::db::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join(".claude.json");

        std::fs::write(&config, r#"{"mcpServers":{"chrome-devtools":{"command":"npx","args":["chrome-devtools-mcp@latest","--autoConnect"]}}}"#).unwrap();
        assert!(configured_server(&config, Path::new("/work")).is_some());

        std::fs::write(&config, r#"{"mcpServers":{"chrome-devtools":{"command":"npx","args":["chrome-devtools-mcp@latest"]}}}"#).unwrap();
        assert!(configured_server(&config, Path::new("/work")).is_none(), "one that launches its own Chrome never prompts");

        std::fs::write(&config, r#"{"mcpServers":{},"projects":{"/work":{"mcpServers":{"chrome-devtools":{"command":"x","args":["--autoConnect"]}}}}}"#).unwrap();
        assert_eq!(configured_server(&config, Path::new("/work")).unwrap()["command"], "x");
        std::fs::remove_dir_all(&dir).ok();
    }
}
