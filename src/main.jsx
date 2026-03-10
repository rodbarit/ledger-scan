import React from 'react'
import ReactDOM from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import App from './App.jsx'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

if (!PUBLISHABLE_KEY) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in environment variables")
}

const clerkAppearance = {
  elements: {
    rootBox: { boxShadow: "0 4px 24px rgba(0,0,0,0.08)", borderRadius: 12, fontFamily: "'Lato', sans-serif" },
    card: { borderRadius: 12, border: "1px solid #e5e2de", fontFamily: "'Lato', sans-serif" },
    headerTitle: { fontFamily: "'Playfair Display', serif", color: "#1a1a2e" },
    headerSubtitle: { color: "#999", fontFamily: "'Lato', sans-serif" },
    socialButtonsBlockButton: { border: "1px solid #e5e2de", borderRadius: 6, fontFamily: "'Lato', sans-serif" },
    formButtonPrimary: { background: "#1a1a2e", borderRadius: 6, fontFamily: "'Lato', sans-serif" },
    footerActionLink: { color: "#2a5298" },
    formFieldInput: { fontFamily: "'Lato', sans-serif" },
    formFieldLabel: { fontFamily: "'Lato', sans-serif" },
  }
};

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ClerkProvider publishableKey={PUBLISHABLE_KEY} appearance={clerkAppearance}>
      <App />
    </ClerkProvider>
  </React.StrictMode>
)
