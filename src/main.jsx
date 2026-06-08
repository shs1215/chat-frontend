import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App.jsx';

import './i18n';

// Agar styles.css mavjud bo‘lsa qoldiring
//import './styles.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);