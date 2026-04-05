/**
 * ThemeSettings.jsx — Theme selection and custom color editor modal.
 *
 * Lists built-in themes, allows cloning to a custom palette. Single-click
 * opens a 120-color swatch grid; double-click opens the native color picker.
 */
import React, { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTheme, THEMES } from '../../store/ThemeContext'
import DraggablePanel from './DraggablePanel'

const PRESET_KEYS = ['dark', 'light', 'colorblind', 'soft', 'highContrast']

const EDITABLE_FIELDS = [
  { key: 'appBg', label: 'Background', group: 'ui' },
  { key: 'panelBg', label: 'Panel', group: 'ui' },
  { key: 'canvasBg', label: 'Canvas', group: 'ui' },
  { key: 'btnBg', label: 'Buttons', group: 'ui' },
  { key: 'textPrimary', label: 'Text', group: 'ui' },
  { key: 'textSecondary', label: 'Text secondary', group: 'ui' },
  { key: 'border', label: 'Borders', group: 'ui' },
  { key: 'geneCds', label: 'CDS', group: 'gene' },
  { key: 'geneExon', label: 'Exon', group: 'gene' },
  { key: 'geneGene', label: 'Gene', group: 'gene' },
  { key: 'geneTranscript', label: 'Transcript', group: 'gene' },
  { key: 'geneUtr', label: 'UTR', group: 'gene' },
  { key: 'geneRrna', label: 'rRNA', group: 'gene' },
  { key: 'geneTrna', label: 'tRNA', group: 'gene' },
  { key: 'geneRepeat', label: 'Repeat', group: 'gene' },
  { key: 'geneDefault', label: 'Default feature', group: 'gene' },
]

// Extended color palette for the popup picker
const PICKER_COLORS = [
  // Grays
  '#000000', '#1a1a1a', '#333333', '#4d4d4d', '#666666',
  '#808080', '#999999', '#b3b3b3', '#cccccc', '#e6e6e6',
  '#f2f2f2', '#ffffff',
  // Reds
  '#4e0000', '#7f0000', '#b71c1c', '#c62828', '#d32f2f',
  '#e53935', '#ef5350', '#f44336', '#ef9a9a', '#ffcdd2',
  '#ffebee', '#fff5f5',
  // Oranges
  '#4e2600', '#7f3d00', '#e65100', '#ef6c00', '#f57c00',
  '#fb8c00', '#ff9800', '#ffa726', '#ffb74d', '#ffcc80',
  '#ffe0b2', '#fff3e0',
  // Yellows
  '#4e4400', '#7f6f00', '#f57f17', '#f9a825', '#fbc02d',
  '#fdd835', '#ffeb3b', '#fff176', '#fff59d', '#fff9c4',
  '#fffde7', '#fffff0',
  // Greens
  '#003300', '#1b5e20', '#2e7d32', '#388e3c', '#43a047',
  '#4caf50', '#66bb6a', '#81c784', '#a5d6a7', '#c8e6c9',
  '#e8f5e9', '#f1f8e9',
  // Teals
  '#003333', '#004d40', '#00695c', '#00796b', '#00897b',
  '#009688', '#26a69a', '#4db6ac', '#80cbc4', '#b2dfdb',
  '#e0f2f1', '#e0f7fa',
  // Blues
  '#001a33', '#0d47a1', '#1565c0', '#1976d2', '#1e88e5',
  '#2196f3', '#42a5f5', '#64b5f6', '#90caf9', '#bbdefb',
  '#e3f2fd', '#e8eaf6',
  // Purples
  '#1a0033', '#311b92', '#4527a0', '#512da8', '#5e35b1',
  '#673ab7', '#7e57c2', '#9575cd', '#b39ddb', '#d1c4e9',
  '#ede7f6', '#f3e5f5',
  // Pinks
  '#330019', '#880e4f', '#ad1457', '#c2185b', '#d81b60',
  '#e91e63', '#ec407a', '#f06292', '#f48fb1', '#f8bbd0',
  '#fce4ec', '#fff0f5',
  // Browns / warm neutrals
  '#1b0000', '#3e2723', '#4e342e', '#5d4037', '#6d4c41',
  '#795548', '#8d6e63', '#a1887f', '#bcaaa4', '#d7ccc8',
  '#efebe9', '#fafafa',
]

export default function ThemeSettings({ onClose }) {
  const { theme, themeName, setThemeName, customTheme, setCustomTheme } = useTheme()
  const [editingCustom, setEditingCustom] = useState(themeName === 'custom')
  const [pickerField, setPickerField] = useState(null)
  const [pickerPos, setPickerPos] = useState({ left: 0, top: 0 })
  const nativeInputRef = useRef(null)
  const nativeFieldRef = useRef(null)

  function selectPreset(key) {
    setThemeName(key)
    setEditingCustom(false)
  }

  function startCustom() {
    const base = themeName === 'custom' ? customTheme : (THEMES[themeName] || THEMES.dark)
    setCustomTheme({ ...base, name: 'Custom' })
    setThemeName('custom')
    setEditingCustom(true)
  }

  function updateCustomField(key, value) {
    setCustomTheme({ ...customTheme, [key]: value })
  }

  function openPicker(fieldKey, e) {
    const rect = e.currentTarget.getBoundingClientRect()
    const spaceRight = window.innerWidth - rect.right
    const pickerW = 290
    const pickerH = 260
    let left, top
    if (spaceRight > pickerW + 10) {
      left = rect.right + 6
      top = Math.min(rect.top, window.innerHeight - pickerH - 10)
    } else {
      left = Math.max(10, rect.left - pickerW - 6)
      top = Math.min(rect.top, window.innerHeight - pickerH - 10)
    }
    setPickerPos({ left, top })
    setPickerField(fieldKey)
  }

  function selectPickerColor(color) {
    if (pickerField) {
      updateCustomField(pickerField, color)
    }
    setPickerField(null)
  }

  function openNativePicker(fieldKey) {
    nativeFieldRef.current = fieldKey
    if (nativeInputRef.current) {
      nativeInputRef.current.value = activeTheme[fieldKey] || '#000000'
      nativeInputRef.current.click()
    }
  }

  function handleNativeChange(e) {
    if (nativeFieldRef.current) {
      updateCustomField(nativeFieldRef.current, e.target.value)
    }
  }

  const S = makeStyles(theme)
  const activeTheme = themeName === 'custom' ? customTheme : (THEMES[themeName] || THEMES.dark)

  return (
    <DraggablePanel title="Color Scheme" onClose={onClose} theme={theme} defaultWidth={420} defaultHeight={480}>
        <div style={S.body}>
          {/* Preset palette buttons */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Presets</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {PRESET_KEYS.map(key => (
                <button
                  key={key}
                  onClick={() => selectPreset(key)}
                  style={{
                    ...S.presetBtn,
                    border: themeName === key ? `2px solid ${theme.textPrimary}` : `1px solid ${theme.borderAccent}`,
                  }}
                >
                  <div style={{ display: 'flex', gap: 2, marginBottom: 4 }}>
                    <span style={{ width: 14, height: 14, borderRadius: 2, background: THEMES[key].appBg, border: '1px solid #555' }} />
                    <span style={{ width: 14, height: 14, borderRadius: 2, background: THEMES[key].headerBg, border: '1px solid #555' }} />
                    <span style={{ width: 14, height: 14, borderRadius: 2, background: THEMES[key].btnBg, border: '1px solid #555' }} />
                  </div>
                  <span style={{ fontSize: 10, color: theme.textSecondary }}>{THEMES[key].name}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Custom palette section */}
          <div style={S.section}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={S.sectionTitle}>Custom Palette</div>
              {!editingCustom ? (
                <button onClick={startCustom} style={S.btn}>
                  Customize
                </button>
              ) : (
                <button onClick={() => setEditingCustom(false)} style={S.smallBtn}>
                  Collapse
                </button>
              )}
            </div>
            {editingCustom && (
              <div>
                <div style={{ fontSize: 10, color: theme.textTertiary, textTransform: 'uppercase', letterSpacing: 1, marginTop: 4, marginBottom: 6 }}>Interface</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px' }}>
                  {EDITABLE_FIELDS.filter(f => f.group === 'ui').map(({ key, label }) => (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span
                        style={{
                          display: 'inline-block', width: 20, height: 16, borderRadius: 3,
                          background: activeTheme[key] || '#000',
                          border: `1px solid ${theme.borderAccent}`,
                          cursor: 'pointer', flexShrink: 0,
                        }}
                        onMouseDown={e => openPicker(key, e)}
                        onDoubleClick={() => { setPickerField(null); openNativePicker(key) }}
                      />
                      <span style={{ fontSize: 11, color: theme.textSecondary }}>{label}</span>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 10, color: theme.textTertiary, textTransform: 'uppercase', letterSpacing: 1, marginTop: 10, marginBottom: 6 }}>Gene Features</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px 12px' }}>
                  {EDITABLE_FIELDS.filter(f => f.group === 'gene').map(({ key, label }) => (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span
                        style={{
                          display: 'inline-block', width: 20, height: 16, borderRadius: 3,
                          background: activeTheme[key] || '#000',
                          border: `1px solid ${theme.borderAccent}`,
                          cursor: 'pointer', flexShrink: 0,
                        }}
                        onMouseDown={e => openPicker(key, e)}
                        onDoubleClick={() => { setPickerField(null); openNativePicker(key) }}
                      />
                      <span style={{ fontSize: 11, color: theme.textSecondary }}>{label}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div style={S.footer}>
          <button style={S.btn} onClick={onClose}>Close</button>
        </div>

      {/* Hidden native color input for double-click full picker */}
      <input
        ref={nativeInputRef}
        type="color"
        onChange={handleNativeChange}
        style={{ position: 'fixed', left: -9999, top: -9999, opacity: 0, width: 0, height: 0 }}
      />

      {/* Color picker popup portal */}
      {pickerField && createPortal(
        <div
          style={{
            position: 'fixed', left: pickerPos.left, top: pickerPos.top, zIndex: 10002,
            background: theme.panelBg, border: `1px solid ${theme.borderAccent}`,
            borderRadius: 6, padding: 8, boxShadow: '0 6px 20px rgba(0,0,0,0.6)',
            display: 'grid', gridTemplateColumns: 'repeat(12, 20px)', gap: 2,
            maxHeight: 300, overflowY: 'auto',
          }}
          onMouseLeave={() => setPickerField(null)}
        >
          {PICKER_COLORS.map((c, i) => (
            <span
              key={i}
              style={{
                width: 20, height: 20, borderRadius: 3, background: c, cursor: 'pointer',
                border: c === (activeTheme[pickerField] || '') ? `2px solid ${theme.textPrimary}` : '1px solid rgba(128,128,128,0.3)',
                boxSizing: 'border-box',
              }}
              onMouseUp={() => selectPickerColor(c)}
            />
          ))}
        </div>,
        document.body
      )}
    </DraggablePanel>
  )
}

function makeStyles(t) {
  return {
    overlay: {
      position: 'fixed', inset: 0, background: t.overlayBg,
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    },
    panel: {
      background: t.panelBg, border: `1px solid ${t.borderAccent}`, borderRadius: 8,
      padding: 0, minWidth: 440, maxWidth: 560, maxHeight: '80vh',
      display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    },
    header: {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '10px 16px', borderBottom: `1px solid ${t.border}`,
    },
    title: { fontSize: 14, fontWeight: 700, color: t.textPrimary },
    closeBtn: {
      background: 'none', border: 'none', color: t.textSecondary, cursor: 'pointer',
      fontSize: 18, lineHeight: 1, padding: '0 4px',
    },
    body: { padding: '8px 0', overflowY: 'auto', flex: 1 },
    section: { padding: '8px 16px' },
    sectionTitle: {
      fontSize: 11, color: t.textSecondary, textTransform: 'uppercase',
      letterSpacing: 1, marginBottom: 0,
    },
    presetBtn: {
      background: t.panelBg, borderRadius: 6, padding: '8px 10px',
      cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center',
      minWidth: 70,
    },
    smallBtn: {
      background: 'none', border: `1px solid ${t.borderAccent}`, borderRadius: 3,
      color: t.textSecondary, cursor: 'pointer', fontSize: 10, padding: '3px 8px',
    },
    btn: {
      background: t.btnBg, border: 'none', borderRadius: 4, color: t.btnText,
      padding: '5px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
    },
    footer: {
      display: 'flex', justifyContent: 'flex-end', padding: '10px 16px',
      borderTop: `1px solid ${t.border}`,
    },
  }
}
