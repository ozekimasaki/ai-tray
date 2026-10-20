//! 生 Win32 のトレイ + コンパクトパネル。WebView は使わない。

use std::mem::size_of;
use std::ptr::null_mut;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BitBlt, BeginPaint, CreateCompatibleBitmap, CreateCompatibleDC, CreateDIBSection, CreateFontW,
    CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, EndPaint, FillRect, GetDC, GetStockObject,
    InvalidateRect, ReleaseDC, SelectObject, SetBkMode, SetTextColor, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, BLACK_BRUSH, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DIB_RGB_COLORS,
    DT_END_ELLIPSIS, DT_NOPREFIX, DT_SINGLELINE, FW_MEDIUM, FW_NORMAL, HBRUSH, HDC, HGDIOBJ,
    OUT_DEFAULT_PRECIS, PAINTSTRUCT, SRCCOPY, TRANSPARENT, VARIABLE_PITCH,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{
    GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY,
    NOTIFYICONDATAW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreateIconIndirect, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyIcon,
    DestroyMenu, DestroyWindow, DispatchMessageW, GetClientRect, GetCursorPos, GetMessageW,
    GetWindowLongPtrW, IsWindowVisible, KillTimer, LoadCursorW, LoadIconW, PostMessageW,
    PostQuitMessage, RegisterClassExW, RegisterWindowMessageW, SetForegroundWindow, SetTimer,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, SystemParametersInfoW, TrackPopupMenu,
    TranslateMessage, CS_DBLCLKS, CS_HREDRAW, CS_VREDRAW, CW_USEDEFAULT, GWLP_USERDATA, HICON,
    HWND_MESSAGE, HWND_TOPMOST, ICONINFO, IDC_ARROW, IDI_APPLICATION, MF_CHECKED, MF_SEPARATOR,
    MF_STRING, MF_UNCHECKED, MSG, SPI_GETWORKAREA, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE,
    SW_SHOWNA, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, TPM_BOTTOMALIGN, TPM_RIGHTALIGN,
    TPM_RIGHTBUTTON, WINDOW_EX_STYLE, WM_ACTIVATE, WM_APP, WM_CLOSE, WM_COMMAND, WM_CREATE,
    WM_DESTROY, WM_ERASEBKGND, WM_LBUTTONUP, WM_MOUSEWHEEL, WM_NCCREATE, WM_PAINT, WM_RBUTTONUP,
    WM_TIMER, WNDCLASSEXW, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_OVERLAPPED, WS_POPUP, WA_INACTIVE,
};

use crate::format::format_ago;
use crate::model::{now_ms, AppState, ProviderCard, Status, Tone};
use crate::providers;
use crate::settings::Settings;

const WM_TRAY: u32 = WM_APP + 1;
const WM_FETCHED: u32 = WM_APP + 2;
const ID_OPEN: usize = 1001;
const ID_REFRESH: usize = 1002;
const ID_DEMO: usize = 1003;
const ID_QUIT: usize = 1004;
const TIMER_REFRESH: usize = 1;
const TIMER_CLOCK: usize = 2;

const PANEL_W: i32 = 380;
const PANEL_H: i32 = 560;

struct Ui {
    hwnd_msg: HWND,
    hwnd_panel: HWND,
    hicon: HICON,
    dpi: i32,
    scroll_y: i32,
    close_rect: RECT,
    refresh_rect: RECT,
    nid: NOTIFYICONDATAW,
    taskbar_created: u32,
    state: AppState,
}

struct FetchMsg {
    now_ms: i64,
    cards: Vec<ProviderCard>,
}

struct Brush(HBRUSH);

impl Drop for Brush {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(HGDIOBJ(self.0 .0));
        }
    }
}

fn rgb(r: u8, g: u8, b: u8) -> COLORREF {
    COLORREF(u32::from(r) | (u32::from(g) << 8) | (u32::from(b) << 16))
}

fn color_bg() -> COLORREF {
    rgb(22, 22, 24)
}
fn color_card() -> COLORREF {
    rgb(36, 36, 40)
}
fn color_track() -> COLORREF {
    rgb(58, 58, 64)
}
fn color_text() -> COLORREF {
    rgb(232, 232, 234)
}
fn color_muted() -> COLORREF {
    rgb(154, 154, 160)
}
fn color_accent() -> COLORREF {
    rgb(110, 168, 254)
}
fn color_warning() -> COLORREF {
    rgb(230, 180, 80)
}
fn color_destructive() -> COLORREF {
    rgb(248, 81, 73)
}
fn color_btn() -> COLORREF {
    rgb(48, 48, 54)
}

fn scale(dpi: i32, v: i32) -> i32 {
    (v * dpi + 48) / 96
}

fn copy_tip(dest: &mut [u16], text: &str) {
    dest.fill(0);
    for (i, unit) in text.encode_utf16().take(dest.len().saturating_sub(1)).enumerate() {
        dest[i] = unit;
    }
}

fn pt_in(rect: RECT, x: i32, y: i32) -> bool {
    x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom
}

fn rect(l: i32, t: i32, r: i32, b: i32) -> RECT {
    RECT {
        left: l,
        top: t,
        right: r,
        bottom: b,
    }
}

unsafe fn fill(hdc: HDC, r: RECT, color: COLORREF) {
    let brush = Brush(CreateSolidBrush(color));
    let _ = FillRect(hdc, &r, brush.0);
}

unsafe fn draw_text(hdc: HDC, text: &str, mut r: RECT, color: COLORREF, font: HGDIOBJ) {
    let old = SelectObject(hdc, font);
    SetBkMode(hdc, TRANSPARENT);
    SetTextColor(hdc, color);
    let mut buf: Vec<u16> = text.encode_utf16().collect();
    if !buf.is_empty() {
        DrawTextW(
            hdc,
            &mut buf,
            &mut r,
            DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS,
        );
    }
    SelectObject(hdc, old);
}

fn logo_bgra(sz: i32) -> Vec<u8> {
    let n = sz as usize;
    let mut px = vec![0u8; n * n * 4];
    let put = |px: &mut [u8], x: i32, y: i32, r: u8, g: u8, b: u8, a: u8| {
        if x < 0 || y < 0 {
            return;
        }
        let (x, y) = (x as usize, y as usize);
        if x >= n || y >= n {
            return;
        }
        let i = (y * n + x) * 4;
        px[i] = b;
        px[i + 1] = g;
        px[i + 2] = r;
        px[i + 3] = a;
    };
    let inside_round = |x: i32, y: i32, l: i32, t: i32, r: i32, b: i32, rad: i32| -> bool {
        if x < l || x >= r || y < t || y >= b {
            return false;
        }
        let cx = if x < l + rad {
            l + rad
        } else if x >= r - rad {
            r - rad - 1
        } else {
            x
        };
        let cy = if y < t + rad {
            t + rad
        } else if y >= b - rad {
            b - rad - 1
        } else {
            y
        };
        if x == cx || y == cy {
            return true;
        }
        let dx = x - cx;
        let dy = y - cy;
        dx * dx + dy * dy <= rad * rad
    };
    for y in 0..sz {
        for x in 0..sz {
            if inside_round(x, y, 1, 1, sz - 1, sz - 1, sz / 5) {
                put(&mut px, x, y, 34, 34, 36, 255);
            }
        }
    }
    let back_l = sz * 10 / 32;
    let back_t = sz * 6 / 32;
    let back_s = sz * 14 / 32;
    let front_l = sz * 6 / 32;
    let front_t = sz * 10 / 32;
    let front_s = sz * 14 / 32;
    for y in 0..sz {
        for x in 0..sz {
            if inside_round(x, y, back_l, back_t, back_l + back_s, back_t + back_s, sz / 8) {
                put(&mut px, x, y, 138, 138, 142, 255);
            }
        }
    }
    for y in 0..sz {
        for x in 0..sz {
            if inside_round(
                x,
                y,
                front_l,
                front_t,
                front_l + front_s,
                front_t + front_s,
                sz / 8,
            ) {
                put(&mut px, x, y, 255, 255, 255, 255);
            }
        }
    }
    px
}

unsafe fn create_logo_icon() -> windows::core::Result<HICON> {
    let sz = 32i32;
    let pixels = logo_bgra(sz);
    let hdc = GetDC(HWND::default());
    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: sz,
            biHeight: -sz,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits: *mut core::ffi::c_void = null_mut();
    let color = CreateDIBSection(hdc, &info, DIB_RGB_COLORS, &mut bits, None, 0)?;
    if !bits.is_null() {
        std::ptr::copy_nonoverlapping(pixels.as_ptr(), bits as *mut u8, pixels.len());
    }
    let mask = windows::Win32::Graphics::Gdi::CreateBitmap(sz, sz, 1, 1, None);
    let icon_info = ICONINFO {
        fIcon: true.into(),
        hbmMask: mask,
        hbmColor: color,
        ..Default::default()
    };
    let icon = CreateIconIndirect(&icon_info)?;
    let _ = DeleteObject(HGDIOBJ(color.0));
    let _ = DeleteObject(HGDIOBJ(mask.0));
    ReleaseDC(HWND::default(), hdc);
    Ok(icon)
}

fn ui_from(hwnd: HWND) -> Option<&'static mut Ui> {
    unsafe {
        let p = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
        if p == 0 {
            None
        } else {
            Some(&mut *(p as *mut Ui))
        }
    }
}

fn attach(hwnd: HWND, ui: *mut Ui) {
    unsafe {
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, ui as isize);
    }
}

pub fn run() -> windows::core::Result<()> {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let hinstance = GetModuleHandleW(None)?;
        let cursor = LoadCursorW(None, IDC_ARROW)?;
        let class_msg = w!("QuotaBarMsg");
        let class_panel = w!("QuotaBarPanel");
        let wc_msg = WNDCLASSEXW {
            cbSize: size_of::<WNDCLASSEXW>() as u32,
            style: CS_DBLCLKS,
            lpfnWndProc: Some(wndproc),
            hInstance: hinstance.into(),
            hCursor: cursor,
            lpszClassName: class_msg,
            ..Default::default()
        };
        let wc_panel = WNDCLASSEXW {
            cbSize: size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS,
            lpfnWndProc: Some(wndproc),
            hInstance: hinstance.into(),
            hCursor: cursor,
            lpszClassName: class_panel,
            hbrBackground: HBRUSH(GetStockObject(BLACK_BRUSH).0),
            ..Default::default()
        };
        RegisterClassExW(&wc_msg);
        RegisterClassExW(&wc_panel);

        let hwnd_msg = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class_msg,
            w!("QuotaBar"),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            None,
            hinstance,
            None,
        )?;

        let hwnd_panel = CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
            class_panel,
            w!("QuotaBar"),
            WS_POPUP,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            PANEL_W,
            PANEL_H,
            None,
            None,
            hinstance,
            None,
        )?;

        let hicon = create_logo_icon().unwrap_or_else(|_| LoadIconW(None, IDI_APPLICATION).unwrap_or_default());
        let settings = Settings::load();
        let mut state = AppState::new(&settings);
        let t = now_ms();
        if state.demo {
            state.apply_demo(t);
        } else {
            state.mark_loading();
        }

        let mut nid = NOTIFYICONDATAW {
            cbSize: size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: hwnd_msg,
            uID: 1,
            uFlags: NIF_MESSAGE | NIF_ICON | NIF_TIP,
            uCallbackMessage: WM_TRAY,
            hIcon: hicon,
            ..Default::default()
        };
        copy_tip(&mut nid.szTip, "QuotaBar");
        if !Shell_NotifyIconW(NIM_ADD, &mut nid).as_bool() {
            return Err(windows::core::Error::from_win32());
        }

        let ui = Box::into_raw(Box::new(Ui {
            hwnd_msg,
            hwnd_panel,
            hicon,
            dpi: 96,
            scroll_y: 0,
            close_rect: RECT::default(),
            refresh_rect: RECT::default(),
            nid,
            taskbar_created: RegisterWindowMessageW(w!("TaskbarCreated")),
            state,
        }));
        attach(hwnd_msg, ui);
        attach(hwnd_panel, ui);

        let ui_ref = &mut *ui;
        ui_ref.dpi = GetDpiForWindow(hwnd_panel).max(96) as i32;
        update_tray_tip(ui_ref);
        let _ = SetTimer(hwnd_msg, TIMER_REFRESH, ui_ref.state.interval_sec * 1000, None);
        let _ = SetTimer(hwnd_msg, TIMER_CLOCK, 15_000, None);
        if !ui_ref.state.demo {
            start_fetch(ui_ref);
        }

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        Ok(())
    }
}

unsafe fn update_tray_tip(ui: &mut Ui) {
    let tip = match ui.state.lowest_left_percent() {
        Some(p) => format!("QuotaBar · {p}% left"),
        None => "QuotaBar".into(),
    };
    copy_tip(&mut ui.nid.szTip, &tip);
    ui.nid.hIcon = ui.hicon;
    ui.nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    let _ = Shell_NotifyIconW(NIM_MODIFY, &mut ui.nid);
}

fn start_fetch(ui: &mut Ui) {
    if ui.state.fetching {
        return;
    }
    let now = now_ms();
    if ui.state.demo {
        ui.state.apply_demo(now);
        unsafe {
            update_tray_tip(ui);
            let _ = InvalidateRect(ui.hwnd_panel, None, false);
        }
        return;
    }
    ui.state.mark_loading();
    unsafe {
        let _ = InvalidateRect(ui.hwnd_panel, None, false);
    }
    let snapshot = ui.state.clone();
    let hwnd_bits = ui.hwnd_msg.0 as isize;
    std::thread::spawn(move || {
        let cards = providers::fetch_enabled(&snapshot);
        let payload = Box::into_raw(Box::new(FetchMsg {
            now_ms: now_ms(),
            cards,
        }));
        unsafe {
            let _ = PostMessageW(
                HWND(hwnd_bits as *mut _),
                WM_FETCHED,
                WPARAM(0),
                LPARAM(payload as isize),
            );
        }
    });
}

fn persist(ui: &Ui) {
    Settings::from_state(&ui.state).save();
}

fn hide_panel(ui: &Ui) {
    unsafe {
        let _ = ShowWindow(ui.hwnd_panel, SW_HIDE);
    }
}

fn panel_visible(ui: &Ui) -> bool {
    unsafe { IsWindowVisible(ui.hwnd_panel).as_bool() }
}

fn toggle_panel(ui: &mut Ui) {
    if panel_visible(ui) {
        hide_panel(ui);
        return;
    }
    show_panel(ui);
}

fn show_panel(ui: &mut Ui) {
    unsafe {
        ui.dpi = GetDpiForWindow(ui.hwnd_panel).max(96) as i32;
        let w = scale(ui.dpi, PANEL_W);
        let h = scale(ui.dpi, PANEL_H);
        let mut cursor = POINT::default();
        let _ = GetCursorPos(&mut cursor);
        let mut work = RECT {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };
        let _ = SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            Some(&mut work as *mut RECT as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
        let mut x = cursor.x - w / 2;
        let mut y = cursor.y - h - scale(ui.dpi, 8);
        if y < work.top {
            y = cursor.y + scale(ui.dpi, 8);
        }
        if x + w > work.right {
            x = work.right - w;
        }
        if x < work.left {
            x = work.left;
        }
        if y + h > work.bottom {
            y = work.bottom - h;
        }
        let _ = SetWindowPos(
            ui.hwnd_panel,
            HWND_TOPMOST,
            x,
            y,
            w,
            h,
            SWP_SHOWWINDOW | SWP_NOACTIVATE,
        );
        let _ = ShowWindow(ui.hwnd_panel, SW_SHOWNA);
        let _ = SetForegroundWindow(ui.hwnd_panel);
        let _ = InvalidateRect(ui.hwnd_panel, None, false);
    }
}

fn show_menu(ui: &mut Ui) {
    unsafe {
        let menu = CreatePopupMenu().unwrap_or_default();
        if menu.is_invalid() {
            return;
        }
        let _ = AppendMenuW(menu, MF_STRING, ID_OPEN, w!("Open panel"));
        let _ = AppendMenuW(menu, MF_STRING, ID_REFRESH, w!("Refresh"));
        let demo_flags = if ui.state.demo {
            MF_STRING | MF_CHECKED
        } else {
            MF_STRING | MF_UNCHECKED
        };
        let _ = AppendMenuW(menu, demo_flags, ID_DEMO, w!("Demo data"));
        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
        let _ = AppendMenuW(menu, MF_STRING, ID_QUIT, w!("Quit"));
        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);
        let _ = SetForegroundWindow(ui.hwnd_msg);
        let _ = TrackPopupMenu(
            menu,
            TPM_RIGHTALIGN | TPM_BOTTOMALIGN | TPM_RIGHTBUTTON,
            pt.x,
            pt.y,
            0,
            ui.hwnd_msg,
            None,
        );
        let _ = DestroyMenu(menu);
    }
}

fn quit(ui: &mut Ui) {
    persist(ui);
    unsafe {
        let _ = KillTimer(ui.hwnd_msg, TIMER_REFRESH);
        let _ = KillTimer(ui.hwnd_msg, TIMER_CLOCK);
        let _ = Shell_NotifyIconW(NIM_DELETE, &mut ui.nid);
        let _ = DestroyWindow(ui.hwnd_panel);
        let _ = DestroyWindow(ui.hwnd_msg);
    }
}

extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        if let Some(ui) = ui_from(hwnd) {
            if msg == ui.taskbar_created && ui.taskbar_created != 0 {
                let _ = Shell_NotifyIconW(NIM_ADD, &mut ui.nid);
                return LRESULT(0);
            }
        }
        match msg {
            WM_NCCREATE | WM_CREATE => DefWindowProcW(hwnd, msg, wparam, lparam),
            WM_TRAY => {
                if let Some(ui) = ui_from(hwnd) {
                    let mouse = lparam.0 as u32;
                    if mouse == WM_LBUTTONUP {
                        toggle_panel(ui);
                    } else if mouse == WM_RBUTTONUP {
                        show_menu(ui);
                    }
                }
                LRESULT(0)
            }
            WM_COMMAND => {
                if let Some(ui) = ui_from(hwnd) {
                    match wparam.0 & 0xFFFF {
                        ID_OPEN => toggle_panel(ui),
                        ID_REFRESH => start_fetch(ui),
                        ID_DEMO => {
                            ui.state.demo = !ui.state.demo;
                            persist(ui);
                            start_fetch(ui);
                        }
                        ID_QUIT => quit(ui),
                        _ => {}
                    }
                }
                LRESULT(0)
            }
            WM_FETCHED => {
                if lparam.0 != 0 {
                    let boxed = Box::from_raw(lparam.0 as *mut FetchMsg);
                    if let Some(ui) = ui_from(hwnd) {
                        ui.state.apply_results(boxed.now_ms, boxed.cards);
                        update_tray_tip(ui);
                        let _ = InvalidateRect(ui.hwnd_panel, None, false);
                    }
                }
                LRESULT(0)
            }
            WM_TIMER => {
                if let Some(ui) = ui_from(hwnd) {
                    if wparam.0 == TIMER_REFRESH {
                        start_fetch(ui);
                    } else if wparam.0 == TIMER_CLOCK && panel_visible(ui) {
                        let _ = InvalidateRect(ui.hwnd_panel, None, false);
                    }
                }
                LRESULT(0)
            }
            WM_ACTIVATE => {
                if hwnd.0 == ui_from(hwnd).map(|u| u.hwnd_panel.0).unwrap_or(null_mut())
                    && (wparam.0 as u32) == WA_INACTIVE
                {
                    if let Some(ui) = ui_from(hwnd) {
                        hide_panel(ui);
                    }
                }
                LRESULT(0)
            }
            WM_CLOSE => {
                if let Some(ui) = ui_from(hwnd) {
                    if hwnd == ui.hwnd_panel {
                        hide_panel(ui);
                        return LRESULT(0);
                    }
                }
                DefWindowProcW(hwnd, msg, wparam, lparam)
            }
            WM_DESTROY => {
                if let Some(ui) = ui_from(hwnd) {
                    if hwnd == ui.hwnd_msg {
                        let _ = Shell_NotifyIconW(NIM_DELETE, &mut ui.nid);
                        if !ui.hicon.is_invalid() {
                            let _ = DestroyIcon(ui.hicon);
                        }
                        let _ = Box::from_raw(ui as *mut Ui);
                        PostQuitMessage(0);
                    }
                }
                LRESULT(0)
            }
            WM_ERASEBKGND => LRESULT(1),
            WM_PAINT => {
                if let Some(ui) = ui_from(hwnd) {
                    if hwnd == ui.hwnd_panel {
                        paint_panel(ui);
                        return LRESULT(0);
                    }
                }
                DefWindowProcW(hwnd, msg, wparam, lparam)
            }
            WM_LBUTTONUP => {
                if let Some(ui) = ui_from(hwnd) {
                    if hwnd == ui.hwnd_panel {
                        let x = (lparam.0 as i32) & 0xFFFF;
                        let y = ((lparam.0 as i32) >> 16) & 0xFFFF;
                        let x = x as i16 as i32;
                        let y = y as i16 as i32;
                        if pt_in(ui.close_rect, x, y) {
                            hide_panel(ui);
                        } else if pt_in(ui.refresh_rect, x, y) {
                            start_fetch(ui);
                        }
                    }
                }
                LRESULT(0)
            }
            WM_MOUSEWHEEL => {
                if let Some(ui) = ui_from(hwnd) {
                    if hwnd == ui.hwnd_panel {
                        let delta = ((wparam.0 >> 16) as i16) as i32;
                        ui.scroll_y -= delta * scale(ui.dpi, 32) / 120;
                        if ui.scroll_y < 0 {
                            ui.scroll_y = 0;
                        }
                        let _ = InvalidateRect(hwnd, None, false);
                    }
                }
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
}

fn tone_color(tone: Tone) -> COLORREF {
    match tone {
        Tone::Normal => color_accent(),
        Tone::Warning => color_warning(),
        Tone::Destructive => color_destructive(),
    }
}

unsafe fn paint_panel(ui: &mut Ui) {
    let mut ps = PAINTSTRUCT::default();
    let hdc = BeginPaint(ui.hwnd_panel, &mut ps);
    let mut client = RECT::default();
    let _ = GetClientRect(ui.hwnd_panel, &mut client);
    let w = client.right - client.left;
    let h = client.bottom - client.top;
    if w <= 0 || h <= 0 {
        let _ = EndPaint(ui.hwnd_panel, &ps);
        return;
    }
    let mem = CreateCompatibleDC(hdc);
    let bmp = CreateCompatibleBitmap(hdc, w, h);
    let old_bmp = SelectObject(mem, HGDIOBJ(bmp.0));
    let dpi = ui.dpi;
    let font = CreateFontW(
        -scale(dpi, 13),
        0,
        0,
        0,
        FW_NORMAL.0 as i32,
        0,
        0,
        0,
        DEFAULT_CHARSET.0 as u32,
        OUT_DEFAULT_PRECIS.0 as u32,
        CLIP_DEFAULT_PRECIS.0 as u32,
        CLEARTYPE_QUALITY.0 as u32,
        VARIABLE_PITCH.0 as u32,
        w!("Segoe UI"),
    );
    let font_bold = CreateFontW(
        -scale(dpi, 14),
        0,
        0,
        0,
        FW_MEDIUM.0 as i32,
        0,
        0,
        0,
        DEFAULT_CHARSET.0 as u32,
        OUT_DEFAULT_PRECIS.0 as u32,
        CLIP_DEFAULT_PRECIS.0 as u32,
        CLEARTYPE_QUALITY.0 as u32,
        VARIABLE_PITCH.0 as u32,
        w!("Segoe UI"),
    );
    let font_small = CreateFontW(
        -scale(dpi, 11),
        0,
        0,
        0,
        FW_NORMAL.0 as i32,
        0,
        0,
        0,
        DEFAULT_CHARSET.0 as u32,
        OUT_DEFAULT_PRECIS.0 as u32,
        CLIP_DEFAULT_PRECIS.0 as u32,
        CLEARTYPE_QUALITY.0 as u32,
        VARIABLE_PITCH.0 as u32,
        w!("Segoe UI"),
    );
    let f = HGDIOBJ(font.0);
    let fb = HGDIOBJ(font_bold.0);
    let fs = HGDIOBJ(font_small.0);

    fill(mem, client, color_bg());
    let pad = scale(dpi, 16);
    draw_text(
        mem,
        "QuotaBar",
        rect(pad, pad, w - scale(dpi, 48), pad + scale(dpi, 22)),
        color_text(),
        fb,
    );
    ui.close_rect = rect(w - scale(dpi, 40), pad - scale(dpi, 2), w - pad, pad + scale(dpi, 24));
    draw_text(mem, "×", ui.close_rect, color_muted(), fb);

    let mut y = pad + scale(dpi, 28);
    draw_text(
        mem,
        &format_ago(now_ms(), ui.state.last_refresh_ms),
        rect(pad, y, w - pad, y + scale(dpi, 18)),
        color_muted(),
        fs,
    );
    y += scale(dpi, 20);
    if ui.state.demo {
        draw_text(
            mem,
            "Demo data",
            rect(pad, y, w - pad, y + scale(dpi, 16)),
            color_warning(),
            fs,
        );
        y += scale(dpi, 18);
    }
    if ui.state.fetching {
        draw_text(
            mem,
            "Fetching…",
            rect(pad, y, w - pad, y + scale(dpi, 16)),
            color_muted(),
            fs,
        );
        y += scale(dpi, 18);
    }

    let footer_h = scale(dpi, 52);
    let clip_top = y;
    let clip_bottom = h - footer_h;
    let cards: Vec<ProviderCard> = ui.state.providers.clone();
    let mut content_y = 0i32;
    let card_gap = scale(dpi, 8);
    for card in &cards {
        let ch = card_height(dpi, card);
        let abs_top = clip_top + content_y - ui.scroll_y;
        let abs_bottom = abs_top + ch;
        if abs_bottom > clip_top && abs_top < clip_bottom {
            paint_card(
                mem,
                dpi,
                rect(pad, abs_top.max(clip_top), w - pad, abs_bottom.min(clip_bottom)),
                abs_top,
                card,
                f,
                fb,
                fs,
            );
        }
        content_y += ch + card_gap;
    }
    let max_scroll = (content_y - (clip_bottom - clip_top)).max(0);
    if ui.scroll_y > max_scroll {
        ui.scroll_y = max_scroll;
    }

    fill(
        mem,
        rect(0, clip_bottom, w, h),
        color_bg(),
    );
    ui.refresh_rect = rect(pad, h - scale(dpi, 44), w - pad, h - scale(dpi, 12));
    fill(mem, ui.refresh_rect, color_btn());
    draw_text(
        mem,
        "Refresh now",
        ui.refresh_rect,
        color_text(),
        fb,
    );

    let _ = BitBlt(hdc, 0, 0, w, h, mem, 0, 0, SRCCOPY);
    SelectObject(mem, old_bmp);
    let _ = DeleteObject(HGDIOBJ(bmp.0));
    let _ = DeleteDC(mem);
    let _ = DeleteObject(f);
    let _ = DeleteObject(fb);
    let _ = DeleteObject(fs);
    let _ = EndPaint(ui.hwnd_panel, &ps);
}

fn card_height(dpi: i32, card: &ProviderCard) -> i32 {
    let mut h = scale(dpi, 52);
    match card.status {
        Status::Ready => h += card.bars.len() as i32 * scale(dpi, 44),
        _ => h += scale(dpi, 36),
    }
    h
}

unsafe fn paint_card(
    hdc: HDC,
    dpi: i32,
    clip: RECT,
    top: i32,
    card: &ProviderCard,
    font: HGDIOBJ,
    font_bold: HGDIOBJ,
    font_small: HGDIOBJ,
) {
    let left = clip.left;
    let right = clip.right;
    let height = card_height(dpi, card);
    let card_rect = rect(left, top, right, top + height);
    fill(hdc, card_rect, color_card());
    let pad = scale(dpi, 10);
    let mut y = top + pad;
    draw_text(
        hdc,
        card.name(),
        rect(left + pad, y, right - scale(dpi, 64), y + scale(dpi, 18)),
        color_text(),
        font_bold,
    );
    draw_text(
        hdc,
        &card.source,
        rect(right - scale(dpi, 60), y, right - pad, y + scale(dpi, 18)),
        color_muted(),
        font_small,
    );
    y += scale(dpi, 20);
    let plan = if card.plan.is_empty() { "-" } else { card.plan.as_str() };
    draw_text(
        hdc,
        plan,
        rect(left + pad, y, right - pad, y + scale(dpi, 16)),
        color_muted(),
        font_small,
    );
    y += scale(dpi, 20);
    match card.status {
        Status::Loading => {
            draw_text(
                hdc,
                "Fetching...",
                rect(left + pad, y, right - pad, y + scale(dpi, 16)),
                color_muted(),
                font_small,
            );
        }
        Status::Missing => {
            draw_text(
                hdc,
                card.hint(),
                rect(left + pad, y, right - pad, y + scale(dpi, 32)),
                color_muted(),
                font_small,
            );
        }
        Status::Failed => {
            let text = if card.error.is_empty() {
                "Failed"
            } else {
                card.error.as_str()
            };
            draw_text(
                hdc,
                text,
                rect(left + pad, y, right - pad, y + scale(dpi, 32)),
                color_destructive(),
                font_small,
            );
        }
        Status::Idle => {
            draw_text(
                hdc,
                "Waiting for refresh",
                rect(left + pad, y, right - pad, y + scale(dpi, 16)),
                color_muted(),
                font_small,
            );
        }
        Status::Ready => {
            let now = now_ms();
            for bar in &card.bars {
                draw_text(
                    hdc,
                    &bar.title,
                    rect(left + pad, y, right - scale(dpi, 90), y + scale(dpi, 16)),
                    color_text(),
                    font,
                );
                draw_text(
                    hdc,
                    &bar.value_label(),
                    rect(right - scale(dpi, 88), y, right - pad, y + scale(dpi, 16)),
                    color_muted(),
                    font_small,
                );
                y += scale(dpi, 18);
                if !bar.is_count {
                    let track = rect(left + pad, y, right - pad, y + scale(dpi, 10));
                    fill(hdc, track, color_track());
                    let span = (track.right - track.left).max(1);
                    let used_w = span * bar.used_percent as i32 / 100;
                    if used_w > 0 {
                        fill(
                            hdc,
                            rect(track.left, track.top, track.left + used_w, track.bottom),
                            tone_color(bar.tone()),
                        );
                    }
                    y += scale(dpi, 12);
                    let reset = bar.reset_label(now);
                    if !reset.is_empty() {
                        draw_text(
                            hdc,
                            &reset,
                            rect(left + pad, y, right - pad, y + scale(dpi, 14)),
                            tone_color(bar.tone()),
                            font_small,
                        );
                    }
                } else {
                    draw_text(
                        hdc,
                        &bar.reset_label(now),
                        rect(left + pad, y, right - pad, y + scale(dpi, 14)),
                        color_muted(),
                        font_small,
                    );
                }
                y += scale(dpi, 14);
            }
        }
    }
    let _ = clip;
}
