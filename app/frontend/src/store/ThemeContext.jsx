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
  colorblind: {
    name: 'Colorblind Friendly',
    appBg: '#1a1a1a', headerBg: '#2a2a2a', panelBg: '#252525',
    canvasBg: '#1a1a1a', inputBg: '#333',
    border: '#333', borderAccent: '#444', borderStrong: '#555',
    btnBg: '#555', btnText: '#fff', btnDanger: '#cc4125',
    textPrimary: '#e0e0e0', textSecondary: '#999', textTertiary: '#777', textMuted: '#666',
    trackName: '#ccc', rulerTick: '#888', rulerLabel: '#ccc',
    tooltipBg: '#333', tooltipBorder: '#555',
    overlayBg: 'rgba(0,0,0,0.55)',
    selectedRow: '#333', centerLine: '#555',
    // Wong palette — safe for deuteranopia, protanopia, tritanopia
    geneCds: '#009e73', geneExon: '#0072b2', geneGene: '#cc79a7',
    geneTranscript: '#d55e00', geneUtr: '#56b4e9',
    geneRrna: '#e69f00', geneTrna: '#f0e442',
    geneRepeat: '#999999', geneDefault: '#56b4e9',
  },
  soft: {
    name: 'Soft',
    appBg: '#f0ede8', headerBg: '#e4dfd8', panelBg: '#e9e5de',
    canvasBg: '#f5f2ed', inputBg: '#fff',
    border: '#d5cfc6', borderAccent: '#c4bdb2', borderStrong: '#a89f93',
    btnBg: '#d5cfc6', btnText: '#4a4540', btnDanger: '#c47066',
    textPrimary: '#3a3530', textSecondary: '#7a7468', textTertiary: '#9a9488', textMuted: '#b5ada2',
    trackName: '#4a4540', rulerTick: '#a89f93', rulerLabel: '#5a5550',
    tooltipBg: '#fff', tooltipBorder: '#d5cfc6',
    overlayBg: 'rgba(0,0,0,0.2)',
    selectedRow: '#ddd8d0', centerLine: '#c4bdb2',
    // Soft but vibrant feature colors
    geneCds: '#4caf50', geneExon: '#2e8bc0', geneGene: '#8e44ad',
    geneTranscript: '#c0392b', geneUtr: '#1abc9c',
    geneRrna: '#e67e22', geneTrna: '#e74c3c',
    geneRepeat: '#8d6e63', geneDefault: '#27ae60',
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
