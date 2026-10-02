import importlib.util
import pathlib
import unittest

path = pathlib.Path(__file__).resolve().parents[1] / 'ops/hetzner/backup/telegram-send.py'
spec = importlib.util.spec_from_file_location('sender', path)
sender = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sender)


class CapacityPolicy(unittest.TestCase):
    def test_numeric_drift_is_not_new_incident(self):
        receipt = pathlib.Path('capacity-check.sh.telegram.json')
        text = '[norva-db] capacity-check\n- WAL 218.49 GiB/jour depasse le seuil de 12.\n- Cout 22136 octets par titre (seuil 12000).\ndb 43.63 GiB'
        other = text.replace('218.49', '225.73').replace('22136', '23305').replace('43.63', '44.7')
        self.assertEqual(sender.delivery_identity(text, receipt), sender.delivery_identity(other, receipt))
        self.assertEqual(sender.delivery_identity(text, receipt)[1], 86400)
        self.assertNotEqual(sender.delivery_identity(text, receipt), sender.delivery_identity(text.replace('218.49', '500'), receipt))

    def test_new_risk_and_critical_backup_alerts_are_preserved(self):
        receipt = pathlib.Path('capacity-check.sh.telegram.json')
        text = '[norva-db] capacity-check\n- WAL 20 GiB/jour depasse le seuil de 12.'
        critical = text+'\n- Disque insuffisant pour le base backup: 2 GiB'
        self.assertEqual(sender.delivery_identity(critical, receipt), (critical, 21600))
        self.assertEqual(sender.delivery_identity(text, pathlib.Path('backup.telegram.json')), (text, 21600))
        self.assertNotEqual(sender.delivery_identity(text, receipt),sender.delivery_identity(text+'\n- Croissance du prefixe WAL R2 30 GiB/jour depasse le seuil de 15.',receipt))

if __name__ == '__main__':
    unittest.main()
