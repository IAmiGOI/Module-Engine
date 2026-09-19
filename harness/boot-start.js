// Побочный эффект при импорте — намеренно: index.js импортирует этот файл ПЕРВЫМ, чтобы экран загрузки встал раньше остального графа модулей.
import { createBootScreen } from './boot-screen.js';

globalThis.__stmeBoot = createBootScreen();
