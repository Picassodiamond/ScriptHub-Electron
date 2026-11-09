/**
 * Line tracing and the step debugger: report which source line of a Python or Bash script is running.
 * Port of runner/tracing.py. The launchers are the same Python/bash text as in the Python app; they are
 * data here (strings handed to the target interpreter), not code that runs in Node.
 *
 * Markers: NUL "SR" <kind> <body> NUL on stderr. Kinds: L lines, P paused, R resumed, V variables (JSON).
 * `MarkerFilter` removes them from the stream again and hands them to the manager.
 */

export const SUPPORTED = ['.py', '.sh']
const START = Buffer.from('\0SR', 'latin1')
const LIMIT: Record<string, number> = { L: 4096, P: 64, R: 8, V: 400_000 } // longest body worth waiting for
export const V_MAX = 256 * 1024 // the debuggee keeps a variables snapshot below this

// Run with `python -c LAUNCHER <script path | -> args...`; "-" reads the script from stdin.
export const PY_LAUNCHER = String.raw`
import os, signal, sys, threading, time, traceback
def _main():
    target = sys.argv[1]
    stopfile = os.environ.pop("SR_TRACE_STOPFILE", "")
    if target == "-":
        fn = "<stdin>"
        src = sys.stdin.buffer.read()
        sys.argv = ["-"] + sys.argv[2:]
    else:
        fn = os.path.abspath(target)
        with open(fn, "rb") as fh:
            src = fh.read()
        sys.argv = [fn] + sys.argv[2:]
        sys.path[0] = os.path.dirname(fn)
    code = compile(src, fn, "exec")
    buf, stop = [], threading.Event()
    def emit():
        items = buf[:]
        del buf[:len(items)]
        if items:
            if len(items) > 300:
                items = items[:100] + items[-200:]
            try:
                os.write(2, b"\0SRL" + ",".join(map(str, items)).encode() + b"\0")
            except OSError:
                pass
    mon = getattr(sys, "monitoring", None)
    if mon is not None:
        tool = 3
        mon.use_tool_id(tool, "scripthub")
        def on_line(c, line):
            if c.co_filename == fn:
                buf.append(line)
            else:
                return mon.DISABLE
        mon.register_callback(tool, mon.events.LINE, on_line)
        mon.set_events(tool, mon.events.LINE)
        def off():
            mon.set_events(tool, 0)
    else:
        def tracer(frame, event, arg):
            if stop.is_set():
                sys.settrace(None)
                return None
            if frame.f_code.co_filename != fn:
                return None
            def local(frame, event, arg):
                if stop.is_set():
                    frame.f_trace = None
                    sys.settrace(None)
                    return None
                if event == "line":
                    buf.append(frame.f_lineno)
                return local
            return local
        sys.settrace(tracer)
        threading.settrace(tracer)
        def off():
            pass
    def stop_now(*_):
        stop.set()
        off()
    if hasattr(signal, "SIGUSR1"):
        signal.signal(signal.SIGUSR1, stop_now)
    done = threading.Event()
    def watch():
        while not done.wait(0.2):
            if stopfile and os.path.exists(stopfile) and not stop.is_set():
                stop_now()
            emit()
    threading.Thread(target=watch, daemon=True).start()
    g = {"__name__": "__main__", "__builtins__": __builtins__, "__doc__": None}
    if target != "-":
        g["__file__"] = fn
    try:
        exec(code, g)
    except SystemExit:
        raise
    except BaseException as exc:
        stop_now()
        done.set()
        emit()
        traceback.print_exception(type(exc), exc, exc.__traceback__.tb_next)
        sys.exit(1)
    finally:
        done.set()
        stop_now()
        emit()
_main()
`

const MARK = String.raw`printf "\0SRL%s\0" "$LINENO" >&2`

/** BASH_ENV file for local runs (the script file itself stays untouched). */
export function bashPrologueFile(_stopfile: string): string {
  return (
    'unset BASH_ENV\n' +
    '__sr_stop="$SR_TRACE_STOPFILE"; unset SR_TRACE_STOPFILE\n' +
    'set -T\n' +
    "trap '[ -e \"$__sr_stop\" ] && { trap - DEBUG; true; } || " + MARK + "' DEBUG\n"
  )
}

/** One line put in front of a script streamed to a remote bash (shifts lines by 1). */
export function bashPrologueLine(): Buffer {
  const mark = String.raw`printf "\0SRL%s\0" "$((LINENO-1))" >&2`
  return Buffer.from("unset BASH_ENV; set -T; trap 'trap - DEBUG' USR1; trap '" + mark + "' DEBUG\n", 'utf8')
}

// Step debugger for Python: `python -c PY_DEBUG_LAUNCHER <script path | -> args...`.
// Control lines arrive on stdin (fd 0 is swapped for the null device first, so the script and its children
// never read them). With "-", stdin starts with "<N>\n" and the N bytes of the script.
export const PY_DEBUG_LAUNCHER = String.raw`
import collections, json, os, reprlib, signal, sys, threading, traceback, types
def _main():
    target = sys.argv[1]
    cfd = os.dup(0)
    try:
        nul = os.open(os.devnull, os.O_RDONLY)
        os.dup2(nul, 0)
        os.close(nul)
    except OSError:
        pass
    ctl = os.fdopen(cfd, "rb")
    if target == "-":
        fn = "<stdin>"
        n = int(ctl.readline().strip() or b"0")
        src = ctl.read(n)
        sys.argv = ["-"] + sys.argv[2:]
    else:
        fn = os.path.abspath(target)
        with open(fn, "rb") as fh:
            src = fh.read()
        sys.argv = [fn] + sys.argv[2:]
        sys.path[0] = os.path.dirname(fn)
    code = compile(src, fn, "exec")

    wl = threading.RLock()
    buf = []
    def out(b):
        with wl:
            try:
                while b:
                    b = b[os.write(2, b):]
            except OSError:
                pass
    def emit():
        with wl:
            items = buf[:]
            del buf[:len(items)]
            if items:
                if len(items) > 300:
                    items = items[:100] + items[-200:]
                out(b"\0SRL" + ",".join(map(str, items)).encode() + b"\0")

    cmds = collections.deque()
    cond = threading.Condition()
    st = {"mode": "step", "bps": set(), "owner": None}
    def reader():
        try:
            for raw in ctl:
                cmds.append(raw.decode("ascii", "replace").strip())
                with cond:
                    cond.notify_all()
        except (OSError, ValueError):
            pass
        cmds.append("detach")
        with cond:
            cond.notify_all()
    threading.Thread(target=reader, daemon=True).start()
    def parse_bps(c):
        return {int(x) for x in c[2:].replace(",", " ").split() if x.isdigit()}
    def running_cmd(c):
        if c in ("pause", "step"):
            st["mode"] = "step"
        elif c == "continue":
            st["mode"] = "run"
        elif c == "detach":
            st["mode"] = "off"
        elif c.startswith("bp"):
            st["bps"] = parse_bps(c)

    rp = reprlib.Repr()
    rp.maxstring = rp.maxother = 160
    rp.maxlist = rp.maxtuple = rp.maxset = rp.maxfrozenset = rp.maxdeque = rp.maxarray = rp.maxdict = 12
    rp.maxlevel = 3
    rp.maxlong = 60
    def scope(d, top):
        res = []
        for k, v in list(d.items()):
            k = str(k)
            if (k.startswith("__") and k.endswith("__")) or isinstance(v, types.ModuleType):
                continue
            if top and isinstance(v, (types.FunctionType, types.BuiltinFunctionType, type)):
                continue
            try:
                r = rp.repr(v)
            except Exception as e:
                r = "<repr failed: %s>" % type(e).__name__
            res.append({"name": k, "type": type(v).__name__, "value": r[:400]})
            if len(res) >= 200:
                break
        return res
    def snapshot(frame):
        try:
            scopes = []
            if frame.f_locals is not frame.f_globals:
                scopes.append({"name": "Locals", "vars": scope(frame.f_locals, False)})
            scopes.append({"name": "Globals", "vars": scope(frame.f_globals, True)})
            stack, f = [], frame
            while f is not None and len(stack) < 50:
                if f.f_code.co_filename == fn:
                    stack.append({"fn": f.f_code.co_name, "line": f.f_lineno})
                f = f.f_back
            snap = {"scopes": scopes, "stack": stack}
            data = json.dumps(snap, ensure_ascii=True).encode()
            for keep in (40, 10, 0):
                if len(data) <= ${V_MAX}:
                    break
                for s in scopes:
                    s["vars"] = s["vars"][:keep]
                data = json.dumps(snap, ensure_ascii=True).encode()
            return data
        except Exception:
            return b'{"scopes": [], "stack": []}'

    def at_line(frame, line):
        """Called for every line of the script; False = debugging is over."""
        if st["mode"] == "off":
            return False
        buf.append(line)
        if not cmds and st["owner"] is None and st["mode"] == "run" and line not in st["bps"]:
            return True
        me = threading.get_ident()
        with cond:
            while st["owner"] is not None and st["owner"] != me:
                cond.wait(0.5)
            while cmds:
                running_cmd(cmds.popleft())
            if st["mode"] == "off":
                return False
            if st["mode"] != "step" and line not in st["bps"]:
                return True
            st["owner"] = me
            with wl:
                emit()
                out(b"\0SRP%d\0" % line)
                out(b"\0SRV" + snapshot(frame) + b"\0")
            while True:
                while not cmds:
                    cond.wait(0.5)
                c = cmds.popleft()
                if c in ("step", "continue", "detach"):
                    running_cmd(c)
                    break
                if c.startswith("bp"):
                    st["bps"] = parse_bps(c)
            st["owner"] = None
            cond.notify_all()
            out(b"\0SRR\0")
            return st["mode"] != "off"

    mon = getattr(sys, "monitoring", None)
    if mon is not None:
        tool = 3
        mon.use_tool_id(tool, "scripthub")
        def on_line(c, line):
            if c.co_filename != fn:
                return mon.DISABLE
            if not at_line(sys._getframe(1), line):
                mon.set_events(tool, 0)
        mon.register_callback(tool, mon.events.LINE, on_line)
        mon.set_events(tool, mon.events.LINE)
        def off():
            mon.set_events(tool, 0)
    else:
        def tracer(frame, event, arg):
            if st["mode"] == "off":
                sys.settrace(None)
                return None
            if frame.f_code.co_filename != fn:
                return None
            def local(frame, event, arg):
                if event == "line" and not at_line(frame, frame.f_lineno):
                    frame.f_trace = None
                    sys.settrace(None)
                    return None
                return local
            return local
        sys.settrace(tracer)
        threading.settrace(tracer)
        def off():
            sys.settrace(None)
    def stop_now(*_):
        cmds.append("detach")
    if hasattr(signal, "SIGUSR1"):
        signal.signal(signal.SIGUSR1, stop_now)
    done = threading.Event()
    def watch():
        while not done.wait(0.2):
            emit()
    threading.Thread(target=watch, daemon=True).start()
    g = {"__name__": "__main__", "__builtins__": __builtins__, "__doc__": None}
    if target != "-":
        g["__file__"] = fn
    try:
        exec(code, g)
    except SystemExit:
        raise
    except BaseException as exc:
        st["mode"] = "off"
        off()
        done.set()
        emit()
        traceback.print_exception(type(exc), exc, exc.__traceback__.tb_next)
        sys.exit(1)
    finally:
        done.set()
        st["mode"] = "off"
        off()
        emit()
_main()
`

/**
 * Step-debugger prologue for bash, as ONE line (it is prepended to the script for SSH runs; `offset` is then 1).
 * Control lines are read from fd 9; the caller makes fd 9 the control stream and stdin /dev/null.
 */
export function bashDebugPrologue(offset = 0): string {
  const parts = [
    'unset BASH_ENV',
    '__sr_main="$0"',
    '__sr_pid=$BASHPID',
    '__sr_m=step',
    "__sr_bp=' '",
    'set -T',
    // one command: step/pause pause at the next line, continue runs, detach ends, bp sets breakpoints
    '__sr_set() { case "$1" in step|pause) __sr_m=step;; continue) __sr_m=run;; detach) __sr_m=off;;' +
      ' bp*) __sr_bp=" ${1#bp}"; __sr_bp="${__sr_bp//,/ } ";; esac; }',
    '__sr_dbg() { [ "$__sr_m" = off ] && return 0;' +
      ' [ "$2" = "$__sr_main" ] && [ "$BASHPID" = "$__sr_pid" ] || return 0;' +
      ` local n=$(( $1 - ${Math.trunc(offset)} )) c;` +
      ' [ "$n" -ge 1 ] || return 0;' +
      " printf '\\0SRL%s\\0' \"$n\" >&2;" +
      ' while read -t 0 -u 9 2>/dev/null; do IFS= read -r -u 9 c || { __sr_m=off; return 0; }; __sr_set "$c"; done;' +
      ' [ "$__sr_m" = off ] && return 0;' +
      ' if [ "$__sr_m" = run ]; then case "$__sr_bp" in *" $n "*) ;; *) return 0;; esac; fi;' +
      " printf '\\0SRP%s\\0' \"$n\" >&2;" +
      ' while :; do IFS= read -r -u 9 c || { __sr_m=off; break; };' +
      ' case "$c" in step|continue|detach) __sr_set "$c"; break;; bp*) __sr_set "$c";; esac; done;' +
      " printf '\\0SRR\\0' >&2; }",
    "trap '__sr_m=off' USR1",
    "trap '__sr_dbg \"$LINENO\" \"${BASH_SOURCE[0]}\"' DEBUG",
  ]
  return parts.join('; ') + '\n'
}

/** BASH_ENV file for local debug runs: fd 9 becomes the control stream. */
export function bashDebugPrologueFile(): string {
  return 'exec 9<&0 0</dev/null\n' + bashDebugPrologue(0)
}

// Runs on the SSH host as `bash -c BASH_DEBUG_LOADER sr-debug args...`. stdin is "<N>\n" + N bytes (prologue
// line + script), then the control lines. The script goes to a temporary file because the debugger needs
// stdin for itself.
export const BASH_DEBUG_LOADER =
  'IFS= read -r __n || exit 125; case "$__n" in ""|*[!0-9]*) exit 125;; esac; ' +
  '__f=$(mktemp) || exit 125; head -c "$__n" > "$__f"; ' +
  'exec 9<&0 0</dev/null; "$BASH" "$__f" "$@"; __rc=$?; rm -f "$__f"; exit $__rc'

/** 'python', 'bash' or null when this script cannot be traced. */
export function kind(extension: string, interpreterStem: string): 'python' | 'bash' | null {
  if (extension === '.py' && interpreterStem.startsWith('python')) return 'python'
  if (extension === '.sh' && interpreterStem === 'bash') return 'bash'
  return null
}

export type DebugEvent = ['P', number] | ['R', null] | ['V', Record<string, any>]

/**
 * Strips markers out of a byte stream; chunk boundaries are handled.
 * `onTrace(numbers)` receives line markers. With `onEvent(kind, value)` the debugger markers are recognised
 * too: ("P", line), ("R", null) and ("V", object). Without it they are left in the stream untouched.
 */
export class MarkerFilter {
  private carry: Buffer = Buffer.alloc(0)
  private kinds: string[]

  constructor(
    private onTrace?: ((numbers: number[]) => void) | null,
    private onEvent?: ((kind: 'P' | 'R' | 'V', value: any) => void) | null,
  ) {
    this.kinds = onEvent ? ['L', 'P', 'R', 'V'] : ['L']
  }

  private dispatch(kindCh: string, body: Buffer): boolean {
    const text = body.toString('latin1')
    if (kindCh === 'L') {
      if (!/^[0-9,]*$/.test(text)) return false
      const nums = text.split(',').filter(Boolean).map((x) => parseInt(x, 10))
      if (nums.length && this.onTrace) this.onTrace(nums)
      return true
    }
    if (kindCh === 'P') {
      if (!/^[0-9]{1,9}$/.test(text)) return false
      this.onEvent!('P', parseInt(text, 10))
      return true
    }
    if (kindCh === 'R') {
      if (body.length) return false
      this.onEvent!('R', null)
      return true
    }
    // V: a JSON snapshot (ASCII only)
    for (const b of body) if (b > 127) return false
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return false
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) this.onEvent!('V', value)
    return true
  }

  feed(chunk: Buffer): Buffer {
    let data = Buffer.concat([this.carry, chunk])
    this.carry = Buffer.alloc(0)
    const out: Buffer[] = []
    for (;;) {
      const i = data.indexOf(START)
      if (i < 0) {
        let keep = 0 // a marker may start at the very end
        for (let n = Math.min(START.length - 1, data.length); n > 0; n--) {
          if (data.subarray(data.length - n).equals(START.subarray(0, n))) {
            keep = n
            break
          }
        }
        out.push(data.subarray(0, data.length - keep))
        this.carry = Buffer.from(data.subarray(data.length - keep))
        break
      }
      out.push(data.subarray(0, i))
      const head = i + START.length
      if (data.length <= head) {
        // the kind byte has not arrived yet
        this.carry = Buffer.from(data.subarray(i))
        break
      }
      const k = String.fromCharCode(data[head])
      if (!this.kinds.includes(k)) {
        out.push(data.subarray(i, i + 1))
        data = data.subarray(i + 1)
        continue
      }
      const j = data.indexOf(0, head + 1)
      if (j < 0) {
        if (data.length - i > LIMIT[k]) {
          // far too long to be a marker
          out.push(data.subarray(i, i + 1))
          data = data.subarray(i + 1)
          continue
        }
        this.carry = Buffer.from(data.subarray(i))
        break
      }
      if (this.dispatch(k, data.subarray(head + 1, j))) data = data.subarray(j + 1)
      else {
        out.push(data.subarray(i, i + 1))
        data = data.subarray(i + 1)
      }
    }
    return Buffer.concat(out)
  }

  flush(): Buffer {
    const rest = this.carry
    this.carry = Buffer.alloc(0)
    return rest
  }
}
