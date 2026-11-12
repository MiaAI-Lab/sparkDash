import { EventEmitter } from "node:events";

/** A child_process stand-in: tests write its stdout and decide when it exits. */
export class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = Object.assign(new EventEmitter(), { setEncoding() {}, unref() {} });
    this.stderr = Object.assign(new EventEmitter(), { setEncoding() {}, unref() {} });
    this.signals = [];
    this.exitCode = null;
    this.signalCode = null;
  }
  unref() {}
  kill(signal = "SIGTERM") {
    this.signals.push(signal);
    return true;
  }
  write(text) {
    this.stdout.emit("data", text);
  }
  exit(code, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }
}
