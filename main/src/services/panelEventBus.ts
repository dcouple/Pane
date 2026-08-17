import { PanelEvent, PanelEventType, PanelEventSubscription } from '../../../shared/types/panels';
import { EventEmitter } from 'events';

class PanelEventBus extends EventEmitter {
  private eventHistory: PanelEvent[] = [];
  private readonly MAX_HISTORY_SIZE = 100;

  constructor() {
    super();
    this.setMaxListeners(100); // Allow many panels to subscribe
  }
  
  emit(eventType: string | symbol, event: PanelEvent): boolean {
    // Add to history
    this.eventHistory.push(event);
    
    // Trim history if needed
    if (this.eventHistory.length > this.MAX_HISTORY_SIZE) {
      this.eventHistory = this.eventHistory.slice(-this.MAX_HISTORY_SIZE);
    }
    
    // Emit the event
    return super.emit(eventType, event);
  }
  
  emitPanelEvent(event: PanelEvent): void {
    this.emit(event.type, event);

    // Also emit a generic 'panel:event' for logging/debugging
    this.emit('panel:event', event);
  }

  unsubscribePanel(panelId: string): void {
    // Panel-specific cleanup logic can be added here if needed
    this.removeAllListeners(panelId);
  }
}

// Export singleton instance
export const panelEventBus = new PanelEventBus();