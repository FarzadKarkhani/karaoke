/* Built-in looks. Each preset only lists what differs from KaraokeStyle.DEFAULT_STYLE. */
window.KARAOKE_PRESETS = [
  {
    id: 'neon', name: 'Neon Night',
    style: {
      background: { type: 'gradient', color: '#0b0720', color2: '#2a0a4a', angle: 150, glow: 0.75, glowColors: ['#7c3aed', '#06b6d4', '#ec4899'], vignette: 0.4 },
      lyrics: { font: 'Vazirmatn', weight: 700, color: '#ffffff', highlight: '#22d3ee', glow: 0.7 },
      visualizer: { type: 'bars', color: '#22d3ee', color2: '#ec4899' },
      progress: { color: '#22d3ee' },
    },
  },
  {
    id: 'gold', name: 'Golden Stage',
    style: {
      background: { type: 'gradient', color: '#0a0a0a', color2: '#201808', angle: 160, glow: 0.45, glowColors: ['#b8860b', '#7a5a12', '#3a2a08'], vignette: 0.5 },
      lyrics: { font: 'Playfair Display', weight: 700, color: '#f5efe0', highlight: '#ffc933', glow: 0.55, otherOpacity: 0.35 },
      visualizer: { type: 'mirror', color: '#ffc933', color2: '#b8860b', opacity: 0.75, height: 0.12, position: 'bottom', bars: 56, thickness: 0.5 },
      title: { color: '#f5efe0' }, progress: { color: '#ffc933' },
    },
  },
  {
    id: 'clean', name: 'Clean Light',
    style: {
      background: { type: 'gradient', color: '#f7f8fc', color2: '#dde6f6', angle: 160, glow: 0.35, glowColors: ['#93c5fd', '#c4b5fd', '#fbcfe8'], pulse: 0.3, vignette: 0.08 },
      lyrics: { font: 'Inter', weight: 700, color: '#1e2740', highlight: '#2563eb', glow: 0, shadow: 0, otherOpacity: 0.45 },
      visualizer: { type: 'wave', color: '#2563eb', color2: '#8b5cf6', opacity: 0.8, height: 0.14, bars: 40 },
      title: { color: '#1e2740' }, footer: { color: '#1e2740' }, progress: { color: '#2563eb' },
    },
  },
  {
    id: 'sunset', name: 'Sunset Pop',
    style: {
      background: { type: 'gradient', color: '#ff7a59', color2: '#7a2cff', angle: 135, glow: 0.55, glowColors: ['#ffd166', '#ef476f', '#118ab2'], vignette: 0.25 },
      lyrics: { font: 'Poppins', weight: 700, color: '#ffffff', highlight: '#fff176', glow: 0.5, shadow: 0.9, outline: 0 },
      visualizer: { type: 'circle', color: '#fff176', color2: '#ffffff', opacity: 0.3, height: 0.1, bars: 48, thickness: 0.4 },
      progress: { color: '#fff176' },
    },
  },
  {
    id: 'studio', name: 'Studio Black',
    style: {
      background: { type: 'solid', color: '#000000', glow: 0, vignette: 0 },
      lyrics: { font: 'Montserrat', weight: 700, color: '#ffffff', highlight: '#ff3b3b', glow: 0.35, otherOpacity: 0.3 },
      visualizer: { type: 'bars', color: '#ff3b3b', color2: '#ff3b3b', opacity: 0.9, height: 0.12, bars: 64, thickness: 0.7 },
      progress: { color: '#ff3b3b' },
    },
  },
  {
    id: 'ocean', name: 'Deep Ocean',
    style: {
      background: { type: 'gradient', color: '#031b2b', color2: '#06485f', angle: 170, glow: 0.65, glowColors: ['#0ea5a4', '#0284c7', '#34d399'], vignette: 0.35 },
      lyrics: { font: 'Vazirmatn', weight: 700, color: '#e6fbff', highlight: '#5eead4', glow: 0.6 },
      visualizer: { type: 'wave', color: '#5eead4', color2: '#0ea5e9', opacity: 0.85, height: 0.2 },
      progress: { color: '#5eead4' },
    },
  },
];
