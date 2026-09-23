import importlib.util
import json
import pathlib
import unittest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, padding

spec=importlib.util.spec_from_file_location('receiver',pathlib.Path(__file__).with_name('provision-media-cache-runtime.py'))
receiver=importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)

class EnvelopeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key=rsa.generate_private_key(public_exponent=65537,key_size=3072)
        cls.pem=cls.key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption())

    def seal(self,payload,label=receiver.LABEL):
        return self.key.public_key().encrypt(json.dumps(payload).encode(),padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),algorithm=hashes.SHA256(),label=label))

    def payload(self):
        return dict(schema=1,issuedAt=1000,ticketKey='a'*64,coordinationKey='b'*64)

    def test_valid(self):
        self.assertEqual(receiver.unseal(self.pem,self.seal(self.payload()),2000),self.payload())

    def test_expired_future_and_non_numeric(self):
        for issued in [-1000000,3000,True,'1000']:
            payload=self.payload();payload['issuedAt']=issued
            with self.assertRaises(ValueError):receiver.unseal(self.pem,self.seal(payload),2000)

    def test_wrong_audience_and_tamper(self):
        with self.assertRaises(ValueError):receiver.unseal(self.pem,self.seal(self.payload(),b'other'),2000)
        blob=bytearray(self.seal(self.payload()));blob[10]^=1
        with self.assertRaises(ValueError):receiver.unseal(self.pem,bytes(blob),2000)

    def test_duplicate_keys_and_extra_fields(self):
        for payload in [dict(self.payload(),coordinationKey='a'*64),dict(self.payload(),enabled=True)]:
            with self.assertRaises(ValueError):receiver.unseal(self.pem,self.seal(payload),2000)

if __name__=='__main__':unittest.main()
