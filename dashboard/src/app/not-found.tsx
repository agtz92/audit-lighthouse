import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="card">
      <div className="empty">
        Esa página no existe.
        <div style={{ marginTop: 8 }}>
          <Link href="/">Volver a todos los sitios</Link>
        </div>
      </div>
    </div>
  );
}
