"""Isolated Linux PTY bridge; protocol stays on pipes, never an on-disk transcript."""
import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios

pid, master = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 34, 110, 0, 0))
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)

pending = b''
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin.buffer], [], [], 0.1)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            print(json.dumps({'data': base64.b64encode(data).decode('ascii')}), flush=True)
        if sys.stdin.buffer in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                break
            pending += data
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                message = json.loads(line)
                if 'write' in message:
                    os.write(master, message['write'].encode('utf-8'))
                if 'resize' in message:
                    cols, rows = message['resize']
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
finally:
    os.close(master)
    try:
        result, status = os.waitpid(pid, os.WNOHANG)
        if result == 0:
            os.kill(pid, signal.SIGTERM)
            _, status = os.waitpid(pid, 0)
        sys.exit(os.waitstatus_to_exitcode(status))
    except ChildProcessError:
        pass
