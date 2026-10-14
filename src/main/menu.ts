import { Menu, type MenuItemConstructorOptions } from 'electron'
import { PRODUCT_NAME } from './app-identity'

/**
 * The application menu: the standard roles plus About.
 *
 * Built rather than left to Electron's default for one item, About, and the
 * default cannot simply be extended. Replacing it carries an obligation on
 * macOS: Cmd-C, Cmd-V, Cmd-Z and Cmd-A are menu accelerators there, so a menu
 * without an Edit menu silently turns copy and paste off in the editor. The
 * Edit role menu is therefore present on every platform.
 *
 * Windows and Linux keep `autoHideMenuBar`, so this bar appears only on Alt;
 * the start screen carries its own About link for that reason.
 */
export function menuTemplate(platform: NodeJS.Platform, openAbout: () => void): MenuItemConstructorOptions[] {
  const about: MenuItemConstructorOptions = { label: `About ${PRODUCT_NAME}`, click: openAbout }
  if (platform === 'darwin') {
    return [
      {
        label: PRODUCT_NAME,
        submenu: [about, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }],
      },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]
  }
  return [
    { label: '&File', submenu: [{ role: 'quit' }] },
    { role: 'editMenu' },
    { label: '&Help', submenu: [about] },
  ]
}

export function installAppMenu(openAbout: () => void): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(process.platform, openAbout)))
}
