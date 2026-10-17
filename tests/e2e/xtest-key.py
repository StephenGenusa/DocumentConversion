"""Press a key chord in one X11 window, as a person at the keyboard would.

    python3 -I tests/e2e/xtest-key.py <window id> <keysym>...    e.g. Control_L comma

Used by ui-state.mjs for what the DevTools protocol cannot do: its key events go
straight to the page and never reach the native menu, where Ctrl+, lives. This
goes through the X server's XTest extension (libXtst, through ctypes, so nothing
to install), the same route as xdotool. XSendEvent is not used: Chromium ignores
synthetic events.

The window is made the active one first (a pager's request, which window managers
honor), the keys go down in order and up in reverse, always, and the window that
was active before gets the focus back. Exit 77 with "skipped: <reason>" on stdout
when this cannot run here (no X display, no libXtst, not an X11 window).
"""
import ctypes
import ctypes.util
import sys
import time

SKIP = 77


def skip(reason):
    print(f"skipped: {reason}")
    sys.exit(SKIP)


def load(name):
    path = ctypes.util.find_library(name)
    if not path:
        skip(f"lib{name} is not installed")
    return ctypes.cdll.LoadLibrary(path)


x11 = load("X11")
xtst = load("Xtst")

Window = ctypes.c_ulong
Atom = ctypes.c_ulong


class XClientMessageEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("window", Window),
        ("message_type", Atom),
        ("format", ctypes.c_int),
        ("data", ctypes.c_long * 5),
    ]


class XEvent(ctypes.Union):
    _fields_ = [("xclient", XClientMessageEvent), ("pad", ctypes.c_long * 24)]


class XWindowAttributes(ctypes.Structure):
    # Only map_state is read; the rest is there to give it the right offset.
    _fields_ = [
        ("x", ctypes.c_int), ("y", ctypes.c_int), ("width", ctypes.c_int), ("height", ctypes.c_int),
        ("border_width", ctypes.c_int), ("depth", ctypes.c_int), ("visual", ctypes.c_void_p),
        ("root", Window), ("class_", ctypes.c_int), ("bit_gravity", ctypes.c_int),
        ("win_gravity", ctypes.c_int), ("backing_store", ctypes.c_int),
        ("backing_planes", ctypes.c_ulong), ("backing_pixel", ctypes.c_ulong),
        ("save_under", ctypes.c_int), ("colormap", ctypes.c_ulong), ("map_installed", ctypes.c_int),
        ("map_state", ctypes.c_int), ("all_event_masks", ctypes.c_long),
        ("your_event_mask", ctypes.c_long), ("do_not_propagate_mask", ctypes.c_long),
        ("override_redirect", ctypes.c_int), ("screen", ctypes.c_void_p),
    ]


x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XDefaultRootWindow.restype = Window
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XInternAtom.restype = Atom
x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XKeysymToKeycode.restype = ctypes.c_ubyte
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XGetWindowAttributes.argtypes = [ctypes.c_void_p, Window, ctypes.POINTER(XWindowAttributes)]
x11.XSendEvent.argtypes = [ctypes.c_void_p, Window, ctypes.c_int, ctypes.c_long, ctypes.POINTER(XEvent)]
x11.XGetWindowProperty.argtypes = [
    ctypes.c_void_p, Window, ctypes.c_ulong,  # display, window, property (an Atom)
    ctypes.c_long, ctypes.c_long, ctypes.c_int, Atom,
    ctypes.POINTER(Atom), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_void_p),
]
x11.XFree.argtypes = [ctypes.c_void_p]
x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
xtst.XTestQueryExtension.argtypes = [ctypes.c_void_p] + [ctypes.POINTER(ctypes.c_int)] * 4
xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

# A bad window id is an X error, which by default ends the process; note it instead.
x_error = []
ERROR_HANDLER = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
on_error = ERROR_HANDLER(lambda _d, _e: x_error.append(True) or 0)
x11.XSetErrorHandler(on_error)

if len(sys.argv) < 3:
    sys.exit("usage: xtest-key.py <window id> <keysym>...")
target = int(sys.argv[1])
dpy = x11.XOpenDisplay(None)
if not dpy:
    skip("no X display to open")
n = ctypes.c_int()
if not xtst.XTestQueryExtension(dpy, ctypes.byref(n), ctypes.byref(n), ctypes.byref(n), ctypes.byref(n)):
    skip("the X server has no XTest extension")
attrs = XWindowAttributes()
x11.XGetWindowAttributes(dpy, target, ctypes.byref(attrs))
x11.XSync(dpy, 0)
if x_error or attrs.map_state != 2:  # IsViewable
    skip(f"window {target} is not a viewable X11 window (a Wayland one?)")
keycodes = []
for name in sys.argv[2:]:
    code = x11.XKeysymToKeycode(dpy, x11.XStringToKeysym(name.encode()))
    if not code:
        sys.exit(f"no key for {name} on this keyboard")
    keycodes.append(code)

root = x11.XDefaultRootWindow(dpy)
NET_ACTIVE_WINDOW = x11.XInternAtom(dpy, b"_NET_ACTIVE_WINDOW", 0)


def active_window():
    kind, fmt, count, left, data = Atom(), ctypes.c_int(), ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_void_p()
    x11.XGetWindowProperty(dpy, root, NET_ACTIVE_WINDOW, 0, 1, 0, 33,  # XA_WINDOW
                           ctypes.byref(kind), ctypes.byref(fmt), ctypes.byref(count), ctypes.byref(left), ctypes.byref(data))
    found = ctypes.cast(data, ctypes.POINTER(Window))[0] if data and count.value else 0
    if data:
        x11.XFree(data)
    return found


def activate(window):
    event = XEvent()
    event.xclient.type = 33  # ClientMessage
    event.xclient.window = window
    event.xclient.message_type = NET_ACTIVE_WINDOW
    event.xclient.format = 32
    event.xclient.data[0] = 2  # from a pager, which focus-stealing prevention lets through
    # SubstructureRedirectMask | SubstructureNotifyMask: to the window manager.
    x11.XSendEvent(dpy, root, 0, (1 << 20) | (1 << 19), ctypes.byref(event))
    x11.XSync(dpy, 0)
    for _ in range(40):
        if active_window() == window:
            return True
        time.sleep(0.05)
    return False


before = active_window()
if not activate(target):
    skip("the window manager would not make the window active")
time.sleep(0.2)  # let Chromium see the focus arrive before the keys
pressed = []
try:
    for code in keycodes:
        xtst.XTestFakeKeyEvent(dpy, code, 1, 0)
        pressed.append(code)
        x11.XSync(dpy, 0)
        time.sleep(0.03)
finally:
    for code in reversed(pressed):
        xtst.XTestFakeKeyEvent(dpy, code, 0, 0)
        x11.XSync(dpy, 0)
        time.sleep(0.03)
# The keys reach the window before the focus leaves it: the X server keeps them in order.
time.sleep(0.2)
if before and before != target:
    activate(before)
x11.XCloseDisplay(dpy)
print("pressed")
