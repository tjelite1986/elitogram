import { NavLink, Link, Outlet, useLocation } from 'react-router-dom';
import { Icon } from '../icons';
import { Avatar, useSession } from '../ui';
import { AdultToggle } from './PinPrompt';

export function Layout() {
  const { me, unread } = useSession();
  const loc = useLocation();
  const reels = loc.pathname.startsWith('/videos');
  if (!me) return null;
  const items = [
    { to: '/', icon: 'home', label: 'Home', end: true },
    { to: '/explore', icon: 'search', label: 'Explore' },
    { to: '/videos', icon: 'reels', label: 'Videos' },
    { to: '/people', icon: 'users', label: 'People' },
    { to: '/notifications', icon: 'bell', label: 'Notifications', badge: unread },
    { to: '/create', icon: 'plus', label: 'Create' },
    { to: '/liked', icon: 'heart', label: 'Liked' },
    { to: '/tags', icon: 'hash', label: 'Hashtags' },
  ];
  return (
    <div className={`app${reels ? ' reels-page' : ''}`}>
      <nav className="rail" aria-label="Main">
        <Link to="/" className="brand">
          Elitogram
        </Link>
        <Link to="/" className="brand-icon" aria-label="Elitogram">
          <img src="/icon.svg" width={26} height={26} alt="" />
        </Link>
        {items.map((it) => (
          <NavLink key={it.to} to={it.to} end={it.end} title={it.label}>
            <Icon name={it.icon} />
            {!!it.badge && <span className="badge-dot">{it.badge > 99 ? '99+' : it.badge}</span>}
            <span className="rail-label">{it.label}</span>
          </NavLink>
        ))}
        <NavLink to={`/user/${me.username}`} title="My profile">
          <Avatar src={me.avatar} size={24} />
          <span className="rail-label">Profile</span>
        </NavLink>
        <div className="spacer" />
        <AdultToggle rail />
        <NavLink to="/settings" title="Settings">
          <Icon name="settings" />
          <span className="rail-label">Settings</span>
        </NavLink>
      </nav>
      {!reels && (
        <header className="topbar mobile-only">
          <Link to="/" className="brand grow">
            Elitogram
          </Link>
          <AdultToggle />
          <Link to="/notifications" className="icon-btn" aria-label="Notifications" style={{ position: 'relative' }}>
            <Icon name="heart" />
            {!!unread && <span className="badge-dot">{unread > 99 ? '99+' : unread}</span>}
          </Link>
          <Link to="/settings" className="icon-btn" aria-label="Settings">
            <Icon name="settings" />
          </Link>
        </header>
      )}
      <main className="main">
        <Outlet />
      </main>
      <nav className="bottom-nav" aria-label="Main">
        <NavLink to="/" end aria-label="Home">
          <Icon name="home" />
        </NavLink>
        <NavLink to="/explore" aria-label="Explore">
          <Icon name="search" />
        </NavLink>
        <NavLink to="/create" aria-label="Create">
          <Icon name="plus" />
        </NavLink>
        <NavLink to="/videos" aria-label="Videos">
          <Icon name="reels" />
        </NavLink>
        <NavLink to="/people" aria-label="People">
          <Icon name="users" />
        </NavLink>
        <NavLink to={`/user/${me.username}`} aria-label="My profile">
          <Avatar src={me.avatar} size={26} />
        </NavLink>
      </nav>
    </div>
  );
}
