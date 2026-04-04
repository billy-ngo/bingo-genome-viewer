/**
 * ThemeContext.jsx — Color theme management (built-in + custom themes).
 *
 * Provides: activeTheme, switchTheme, updateTheme, addCustomTheme, etc.
 * Persists custom themes and active selection in localStorage.
 */
import React, { createContext, useContext, useState, useCallback, useEffect } from 'react'

const ThemeContext = createContext(null)

const GENE_COLORS_DEFAULT = {
  geneCds: '#66bb6a', geneExon: '#42a5f5', geneGene: '#7e57c2',
  geneTranscript: '#ab47bc', geneUtr: '#26c6da',
  geneRrna: '#ffa726', geneTrna: '#ef5350',
  geneRepeat: '#8d6e63', geneDefault: '#80cbc4',
}

export const THEMES = {
  dark: {
    name: 'Dark',
    appBg: '#1a1a1a', headerBg: '#2a2a2a', panelBg: '#252525',
    canvasBg: '#1a1a1a', inputBg: '#333',
    border: '#333', borderAccent: '#444', borderStrong: '#555',
    btnBg: '#555', btnText: '#fff', btnDanger: '#c62828',
    textPrimary: '#e0e0e0', textSecondary: '#999', textTertiary: '#777', textMuted: '#666',
    trackName: '#ccc', rulerTick: '#888', rulerLabel: '#ccc',
    tooltipBg: '#333', tooltipBorder: '#555',
    overlayBg: 'rgba(0,0,0,0.55)',
    selectedRow: '#333', centerLine: '#555',
    ...GENE_COLORS_DEFAULT,
  },
  light: {
    name: 'Light',
    appBg: '#f5f5f5', headerBg: '#ffffff', panelBg: '#eee',
    canvasBg: '#ffffff', inputBg: '#fff',
    border: '#ddd', borderAccent: '#bbb', borderStrong: '#999',
    btnBg: '#e0e0e0', btnText: '#333', btnDanger: '#d32f2f',
    textPrimary: '#222', textSecondary: '#666', textTertiary: '#888', textMuted: '#aaa',
    trackName: '#333', rulerTick: '#666', rulerLabel: '#333',
    tooltipBg: '#fff', tooltipBorder: '#ccc',
    overlayBg: 'rgba(0,0,0,0.25)',
    selectedRow: '#dde4ee', centerLine: '#ccc',
    ...GENE_COLORS_DEFAULT,
  },
  midnight: {
    name: 'Midnight Blue',
    appBg: '#1a1a2e', headerBg: '#0f3460', panelBg: '#16213e',
    canvasBg: '#0d2137', inputBg: '#0f3460',
    border: '#0f3460', borderAccent: '#1a4a7a', borderStrong: '#1565c0',
    btnBg: '#1565c0', btnText: '#fff', btnDanger: '#c62828',
    textPrimary: '#e0e0e0', textSecondary: '#90a4ae', textTertiary: '#546e7a', textMuted: '#37474f',
    trackName: '#90caf9', rulerTick: '#4fc3f7', rulerLabel: '#90caf9',
    tooltipBg: '#16213e', tooltipBorder: '#1a4a7a',
    overlayBg: 'rgba(0,0,0,0.55)',
    selectedRow: '#0f3460', centerLine: '#37474f',
    ...GENE_COLORS_DEFAULT,
  },
  solarized: {
    name: 'Solarized Dark',
    appBg: '#002b36', headerBg: '#073642', panelBg: '#073642',
    canvasBg: '#002b36', inputBg: '#073642',
    border: '#586e75', borderAccent: '#657b83', borderStrong: '#839496',
    btnBg: '#586e75', btnText: '#fdf6e3', btnDanger: '#dc322f',
    textPrimary: '#fdf6e3', textSecondary: '#93a1a1', textTertiary: '#839496', textMuted: '#657b83',
    trackName: '#eee8d5', rulerTick: '#93a1a1', rulerLabel: '#eee8d5',
    tooltipBg: '#073642', tooltipBorder: '#586e75',
    overlayBg: 'rgba(0,0,0,0.55)',
    selectedRow: '#073642', centerLine: '#586e75',
    geneCds: '#859900', geneExon: '#268bd2', geneGene: '#6c71c4',
    geneTranscript: '#d33682', geneUtr: '#2aa198',
    geneRrna: '#b58900', geneTrna: '#dc322f',
    geneRepeat: '#cb4b16', geneDefault: '#2aa198',
  },
  highContrast: {
    name: 'High Contrast',
    appBg: '#000', headerBg: '#111', panelBg: '#111',
    canvasBg: '#000', inputBg: '#222',
    border: '#444', borderAccent: '#666', borderStrong: '#888',
    btnBg: '#444', btnText: '#fff', btnDanger: '#f44336',
    textPrimary: '#fff', textSecondary: '#ccc', textTertiary: '#aaa', textMuted: '#888',
    trackName: '#fff', rulerTick: '#aaa', rulerLabel: '#fff',
    tooltipBg: '#222', tooltipBorder: '#666',
    overlayBg: 'rgba(0,0,0,0.7)',
    selectedRow: '#333', centerLine: '#555',
    geneCds: '#4caf50', geneExon: '#2196f3', geneGene: '#9c27b0',
    geneTranscript: '#e040fb', geneUtr: '#00e5ff',
    geneRrna: '#ff9800', geneTrna: '#ff1744',
    geneRepeat: '#ff6e40', geneDefault: '#69f0ae',
  },
}

const STORAGE_KEY = 'genomics-viewer-theme'
const CUSTOM_STORAGE_KEY = 'genomics-viewer-custom-theme'

function loadSaved() {
  try {
    const name = localStorage.getItem(STORAGE_KEY)
    const custom = localStorage.getItem(CUSTOM_STORAGE_KEY)
    return {
      name: name && (THEMES[name] || name === 'custom') ? name : 'dark',
      custom: custom ? JSON.parse(custom) : null,
    }
  } catch { return { name: 'dark', custom: null } }
}

export function ThemeProvider({ children }) {
  const saved = loadSaved()
  const [themeName, setThemeNameState] = useState(saved.name)
  const [customTheme, setCustomThemeState] = useState(
    saved.custom || { ...THEMES.dark, name: 'Custom' }
  )

  const theme = themeName === 'custom' ? customTheme : (THEMES[themeName] || THEMES.dark)

  const setThemeName = useCallback((name) => {
    setThemeNameState(name)
    localStorage.setItem(STORAGE_KEY, name)
  }, [])

  const setCustomTheme = useCallback((t) => {
    setCustomThemeState(t)
    localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(t))
  }, [])

  // Apply body background
  useEffect(() => {
    document.body.style.background = theme.appBg
    document.body.style.color = theme.textPrimary
  }, [theme.appBg, theme.textPrimary])

  return (
    <ThemeContext.Provider value={{ theme, themeName, setThemeName, customTheme, setCustomTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}
