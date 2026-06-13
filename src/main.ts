import './style.css';
import { mountApp } from './ui/app';
import { APP_VERSION } from './version';

mountApp(document.getElementById('app')!, APP_VERSION);
