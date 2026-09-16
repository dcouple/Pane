package com.dcouple.pane.mobile;

import com.getcapacitor.BridgeActivity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(android.os.Bundle savedInstanceState) {
    registerPlugin(SecureStorePlugin.class);
    super.onCreate(savedInstanceState);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationChannel channel = new NotificationChannel(
        "pane_attention", "Pane attention", NotificationManager.IMPORTANCE_DEFAULT
      );
      channel.setDescription("Alerts when a Pane needs input or completes a turn.");
      getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }
  }
}
