import React from 'react'
import { createRoot } from 'react-dom/client'
import Popup from './components/Popup'

const root = createRoot(document.getElementById('popup-root')!)
root.render(React.createElement(Popup))
