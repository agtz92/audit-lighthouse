import type { NextConfig } from 'next';

const config: NextConfig = {
  // Imagen de Docker mínima: copia solo lo que el servidor necesita.
  output: 'standalone',
  // El dashboard es de solo lectura sobre datos que cambian una vez al día;
  // no necesita el prerenderizado agresivo de Next.
  reactStrictMode: true,
  poweredByHeader: false,
};

export default config;
