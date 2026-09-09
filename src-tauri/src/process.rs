use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::error::{Error, Result};

#[derive(Debug)]
pub struct Output {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    /// Untrimmed, undecoded stdout, for the commands whose output is not text —
    /// a clipboard image comes back as PNG bytes, which lossy UTF-8 destroys.
    pub bytes: Vec<u8>,
}

/// Runs a command with a deadline, reading its output on separate threads.
///
/// The reading matters: polling for exit while the child fills a 64KB pipe
/// buffer deadlocks both sides. The deadline matters because these are other
/// people's CLIs doing network work — `claude mcp list` health-checks every
/// server, and one unreachable server should not wedge a panel forever.
pub fn run(mut command: Command, timeout: Duration) -> Result<Output> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::Invalid(format!("could not run the command: {e}")))?;

    let drain = |pipe: Option<_>| {
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            if let Some(mut pipe) = pipe as Option<Box<dyn Read + Send>> {
                let _ = pipe.read_to_end(&mut buffer);
            }
            buffer
        })
    };
    let stdout = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));

    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::Invalid(format!(
                "the command took longer than {}s and was stopped",
                timeout.as_secs()
            )));
        }
        std::thread::sleep(Duration::from_millis(40));
    };

    let collect = |handle: std::thread::JoinHandle<Vec<u8>>| handle.join().unwrap_or_default();
    let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).trim().to_string();

    let bytes = collect(stdout);
    Ok(Output {
        ok: status.success(),
        stdout: text(&bytes),
        stderr: text(&collect(stderr)),
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_comes_back_whole() {
        let mut command = Command::new("sh");
        command.args(["-c", "printf hello; printf oops >&2"]);

        let output = run(command, Duration::from_secs(5)).unwrap();
        assert!(output.ok);
        assert_eq!(output.stdout, "hello");
        assert_eq!(output.stderr, "oops");
    }

    #[test]
    fn a_hung_command_is_stopped_rather_than_waited_on() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30"]);

        let started = Instant::now();
        let error = run(command, Duration::from_millis(300)).unwrap_err();

        assert!(started.elapsed() < Duration::from_secs(5), "it waited too long");
        assert!(error.to_string().contains("was stopped"), "{error}");
    }

    #[test]
    fn more_output_than_a_pipe_buffer_does_not_deadlock() {
        let mut command = Command::new("sh");
        command.args(["-c", "yes abcdefgh | head -c 300000"]);

        let output = run(command, Duration::from_secs(10)).unwrap();
        assert_eq!(output.stdout.len(), 300_000);
    }
}
