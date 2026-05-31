import './style.css';
import { mountApp } from './ui/app';

declare const __APP_VERSION__: string;

mountApp(document.getElementById('app')!, __APP_VERSION__);
