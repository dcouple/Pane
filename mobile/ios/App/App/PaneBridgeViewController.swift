import Capacitor

final class PaneBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(SecureStorePlugin())
    }
}
