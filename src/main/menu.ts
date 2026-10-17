import { Menu, type MenuItemConstructorOptions } from 'electron'
import { PRODUCT_NAME } from './app-identity'

/** What the menu's own items do. */
export interface MenuActions {
  openAbout: () => void
  /** The Settings dialog, in the main window (settings spec 7.1). */
  openSettings: () => void
}

/**
 * The application menu: the standard roles plus About and Settings.
 *
 * Built rather than left to Electron's default for two items, About and
 * Settings, and the default cannot simply be extended. Replacing it carries an obligation on
 * macOS: Cmd-C, Cmd-V, Cmd-Z and Cmd-A are menu accelerators there, so a menu
 * without an Edit menu silently turns copy and paste off in the editor. The
 * Edit role menu is therefore present on every platform.
 *
 * Windows and Linux keep `autoHideMenuBar`, so this bar appears only on Alt;
 * the start screen carries its own About and Settings links for that reason.
 * Settings is Cmd+, on macOS and Ctrl+, elsewhere; as an accelerator it works
 * from the editor too.
 */
export function menuTemplate(platform: NodeJS.Platform, actions: MenuActions): MenuItemConstructorOptions[] {
  const about: MenuItemConstructorOptions = { label: `About ${PRODUCT_NAME}`, click: actions.openAbout }
  const settings: MenuItemConstructorOptions = {
    id: 'settings',
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: actions.openSettings,
  }
  if (platform === 'darwin') {
    return [
      {
        label: PRODUCT_NAME,
        submenu: [
          about,
          { type: 'separator' },
          settings,
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]
  }
  return [
    { label: '&File', submenu: [settings, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' },
    { label: '&Help', submenu: [about] },
  ]
}

export function installAppMenu(actions: MenuActions): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(process.platform, actions)))
}
