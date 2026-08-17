// Session context — the signed-in principal, shared across the router without prop-drilling.
import { createContext, useContext } from "react";

import type { Principal } from "./api";

export interface SessionValue {
  who: Principal | null;
  setWho: (who: Principal | null) => void;
}

export const SessionContext = createContext<SessionValue>({ who: null, setWho: () => {} });

export const useSession = (): SessionValue => useContext(SessionContext);
