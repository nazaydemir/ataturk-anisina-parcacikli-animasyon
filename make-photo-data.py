# Kullanım: python make_photo_data.py foto.jpg
# Fotoğrafı photo-data.js içine gömer (file:// ile açınca da çalışsın diye).
import sys, base64, io
from PIL import Image
im = Image.open(sys.argv[1]).convert('L')
im.thumbnail((720, 900))
buf = io.BytesIO(); im.save(buf, 'JPEG', quality=88)
b = base64.b64encode(buf.getvalue()).decode()
open('photo-data.js', 'w').write('const PHOTO_DATA = "data:image/jpeg;base64,%s";\n' % b)