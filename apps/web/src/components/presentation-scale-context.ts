import { createContext } from 'react';

/**
 * The CSS zoom around the widgets that read it, so charts can draw their canvas at the scaled pixel ratio. 1 outside
 * the scaled presentation page: the maximised widget, dialogs and the editor are not zoomed.
 */
export const PresentationScaleContext = createContext(1);
