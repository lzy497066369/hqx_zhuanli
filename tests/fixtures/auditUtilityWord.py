"""Audit rendered Word fixtures: python auditUtilityWord.py DOCX_DIR RENDER_DIR."""
import hashlib
import json
import re
import sys
from pathlib import Path
from zipfile import ZipFile

import pdfplumber
from lxml import etree

HEADERS = ['说明书摘要', '摘要附图', '权利要求书', '说明书', '说明书附图']
HEADINGS = {'技术领域', '背景技术', '实用新型内容', '附图说明', '具体实施方式', '工作原理',
            '部件及设置理由：', '连接关系：', '运动关系：'}
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}


def compact(text):
    return re.sub(r'\s+', '', text)


results, identical_pages = {}, {}
source_dir, render_dir = map(Path, sys.argv[1:3])
for variant in ['normal', 'long', 'short', 'annotated', 'extended']:
    records, body_text = [], []
    folder = render_dir / variant
    with pdfplumber.open(folder / f'{variant}.pdf') as document:
        assert len(list(folder.glob('page-*.png'))) == len(document.pages)
        for index, page in enumerate(document.pages, 1):
            assert abs(page.width - 595.3) < 0.1 and abs(page.height - 841.9) < 0.1
            header = ''.join(c['text'] for c in page.chars if c['top'] < 71)
            footer = [c for c in page.chars if c['top'] > 800]
            assert header in HEADERS, (variant, index, header)
            assert ''.join(c['text'] for c in footer) == str(index)
            center = (70.9 + 552.75) / 2
            assert abs((min(c['x0'] for c in footer) + max(c['x1'] for c in footer)) / 2 - center) < 0.5
            body = page.filter(lambda obj: obj['object_type'] == 'char' and 71 <= obj['top'] < 800)
            text = body.extract_text() or ''
            body_text.append(text)
            assert text.strip() or page.images, (variant, index, 'empty page')
            assert text.splitlines()[-1:] not in [[h] for h in HEADINGS], (variant, index, 'orphan heading')
            for char in body.chars:
                tolerance = 14.2 if char['text'] in '，。；：！？、）】”’' else 0.5
                assert char['x0'] >= 70.9 - 0.5, (variant, index, 'left overflow')
                assert char['x1'] <= 552.75 + tolerance, (variant, index, 'right overflow')
                assert char['bottom'] <= 799.4, (variant, index, 'footer collision')
            for image in page.images:
                assert image['x0'] >= 70.9 - 0.1 and image['x1'] <= 552.75 + 0.1
                assert image['top'] >= 70.85 - 0.1 and image['bottom'] <= 799.4
                assert abs((image['x0'] + image['x1']) / 2 - center) < 0.5
                assert abs((image['x1'] - image['x0']) / (image['bottom'] - image['top']) - 794 / 1123) < 0.0001
            if header == '说明书附图':
                figure_index = sum(r['header'] == header for r in records) + 1
                assert len(page.images) == 1 and text == f'图{figure_index}'
                assert min(c['top'] for c in body.chars) > page.images[0]['bottom']
                assert abs((min(c['x0'] for c in body.chars) + max(c['x1'] for c in body.chars)) / 2 - center) < 0.5
            records.append({'page': index, 'header': header, 'images': len(page.images)})
            image_path = folder / f'page-{index}.png'
            digest = hashlib.sha256(image_path.read_bytes()).hexdigest()
            identical_pages.setdefault(digest, []).append(str(image_path))
    rendered = compact(''.join(body_text))
    with ZipFile(source_dir / f'{variant}.docx') as archive:
        assert archive.testzip() is None
        root = etree.fromstring(archive.read('word/document.xml'))
        source = root.xpath('//w:t/text()', namespaces=NS)
    assert rendered == compact(''.join(source)), (variant, 'rendered text differs')
    assert not re.search(r'拟议结构|待实物核对|AI分析|AI备注|标记为创新|Evidence|internal|draft|需人工核对|不代表授权结论', rendered)
    if variant != 'extended':
        assert not re.search(r'E0[123]|待核对|validation', rendered)
    else:
        assert 'E01/E03型连接器提供validation模式' in rendered
        assert '壳体侧面设有排水槽，排水槽与外侧连通。' in rendered
    assert list(dict.fromkeys(r['header'] for r in records)) == HEADERS
    results[variant] = {'pages': len(records), 'sections': {h: [r['page'] for r in records if r['header'] == h] for h in HEADERS}}

assert results['long']['pages'] > results['short']['pages']
print(json.dumps({'documents': results, 'identical_pages': list(identical_pages.values())}, ensure_ascii=False, indent=2))
