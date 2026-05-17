'use client';

/**
 * DAW provider stack: meters isolation + performance profile context.
 * Location: apps/dashboard/components/daw — entry from app/page.js
 */

import MetersProvider from '../../context/meters-context.jsx';
import StuuShell from '../stuu-shell.jsx';

export default function DawShell() {
  return (
    <MetersProvider>
      <StuuShell />
    </MetersProvider>
  );
}
