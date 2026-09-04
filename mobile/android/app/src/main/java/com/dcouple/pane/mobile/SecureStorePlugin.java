package com.dcouple.pane.mobile;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "SecureStore")
public class SecureStorePlugin extends Plugin {
  private EncryptedSharedPreferences preferences;
  private EncryptedSharedPreferences preferences() throws Exception {
    if (preferences == null) {
      MasterKey key = new MasterKey.Builder(getContext()).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build();
      preferences = (EncryptedSharedPreferences) EncryptedSharedPreferences.create(getContext(), "pane-secure-store", key, EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV, EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
    }
    return preferences;
  }
  @PluginMethod public void get(PluginCall call) { try { String key = call.getString("key"); if (key == null) { call.reject("A key is required"); return; } JSObject result = new JSObject(); String value = preferences().getString(key, null); if (value != null) result.put("value", value); call.resolve(result); } catch (Exception error) { call.reject("Secure storage read failed", error); } }
  @PluginMethod public void set(PluginCall call) { try { String key = call.getString("key"); String value = call.getString("value"); if (key == null || value == null) { call.reject("A key and value are required"); return; } preferences().edit().putString(key, value).apply(); call.resolve(); } catch (Exception error) { call.reject("Secure storage write failed", error); } }
  @PluginMethod public void remove(PluginCall call) { try { String key = call.getString("key"); if (key == null) { call.reject("A key is required"); return; } preferences().edit().remove(key).apply(); call.resolve(); } catch (Exception error) { call.reject("Secure storage delete failed", error); } }
}
