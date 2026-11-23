export function cliControls(close) {
  let stopTurn;
  let started;
  let timer;
  let interrupted = false;
  const force = code => {
    try { close(); }
    finally { process.exit(code); }
  };
  const streamError = error => {
    if (error.code === 'EPIPE') force(0);
    else throw error;
  };
  const interrupt = () => {
    const now = Date.now();
    if (!stopTurn || (started !== undefined && now - started <= 2000)) force(130);
    if (started !== undefined) return;
    started = now;
    interrupted = true;
    stopTurn();
    timer = setTimeout(() => force(130), 5000);
  };
  const terminate = () => force(130);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  process.stdout.on('error', streamError);
  process.stderr.on('error', streamError);
  return {
    get interrupted() { return interrupted; },
    interrupt,
    stop() { stopTurn?.(); },
    setActive(stop) {
      stopTurn = stop;
      if (!stop) {
        clearTimeout(timer);
        started = undefined;
      }
    },
    close() {
      clearTimeout(timer);
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
      // Leave the stream handlers installed until process exit. A buffered pipe can fail after this returns.
    },
  };
}
