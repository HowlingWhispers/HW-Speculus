import { useEffect, useState } from 'react';

// Touch phones only: desktop browser layout and keyboard behavior stay intact.
export const PHONE_QUERY = '(max-width: 780px) and (pointer: coarse), (max-width: 1000px) and (max-height: 500px) and (pointer: coarse)';

export function usePhoneLayout() {
  const [phone, setPhone] = useState(() => window.matchMedia?.(PHONE_QUERY).matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.(PHONE_QUERY);
    if (!query) return;
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return phone;
}
