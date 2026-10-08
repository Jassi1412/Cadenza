"""Inserisce marcature di dinamica in uno spartito MusicXML, senza toccare l'originale.

Curva dell'arrangiamento (misure 1-16, 2/2):
  registro alto: 93 91 91 89 89 88 88 86  |  93 91 94 93 96 94 93 89
                 m1------discende----m8   m9---cresce--m13---scende---m16
  vetta assoluta: m13 (pitch 96)
  punto piu' basso: m8 (pitch 86)

Le dinamiche seguono quella curva. `<sound dynamics="N">` e' il valore MIDI
che partitura riapre e con cui confrontiamo la velocity del tasto premuto.
"""
import copy
import shutil
import sys

from lxml import etree

SRC, DST = sys.argv[1], sys.argv[2]

# MusicXML standard dynamics -> velocity MIDI
#
# Stessa mappa di join.py, centri a meta' intero perche' la regola RML accetta
# entro 8 dal valore e cosi' le 8 fasce si spartiscono tutte e 128 le velocity
# senza buchi e senza sovrapposizioni. Se cambi un numero, cambialo anche li'.
DYN = {
    "ppp": 7.5, "pp": 23.5, "p": 39.5, "mp": 55.5, "mf": 71.5,
    "f": 87.5, "ff": 103.5, "fff": 119.5,
}

# misura 1-indexata -> dinamica
MARKINGS = [
    (1,  "mp", "apertura: leggera, scintillante"),
    (8,  "mf", "la frase si riapre con piu' peso"),
    (13, "f",  "vetta: registro massimo (pitch 96)"),
    (16, "p",  "chiusura: torna sulla sfumata iniziale"),
]

tree = etree.parse(SRC)
root = tree.getroot()
measures = root.findall(".//measure")
print("misure trovate:", len(measures))

by_number = {}
for m in measures:
    n = m.get("number")
    if n is not None:
        by_number[int(n)] = m

added = []
for num, name, why in MARKINGS:
    m = by_number.get(num)
    if m is None:
        print("  misura %d ASSENTE, salto %s" % (num, name))
        continue

    # non duplicare: se c'e' gia' una <dynamics> in questa misura, non toccare
    if m.find(".//dynamics") is not None:
        print("  misura %d: ha gia' una dinamica, salto" % num)
        continue

    direction = etree.SubElement(m, "direction", placement="below")
    dtype = etree.SubElement(direction, "direction-type")
    dynamics = etree.SubElement(dtype, "dynamics")
    etree.SubElement(dynamics, name)
    etree.SubElement(direction, "sound", dynamics=str(round(DYN[name])))
    # NOTA: sound/@dynamics secondo la specifica MusicXML 4.0 e' una percentuale
    # del forte di default (90), non una velocity assoluta. Qui dentro ci mettiamo
    # la velocity, quindi il valore non e' interoperabile. Non e' un difetto che
    # si vede all'interno del progetto perche' join.py rilegge il testo della
    # dinamica (<mp/> e simili) e non questo attributo. TODO: metterci la percentuale.

    # la <direction> deve precedere la prima nota della misura
    first_note = m.find("note")
    if first_note is not None:
        m.remove(direction)
        first_note.addprevious(direction)
    added.append((num, name, DYN[name], why))
    print("  misura %-2d  %-3s  velocity %-5s  (%s)" % (num, name, DYN[name], why))

tree.write(DST, xml_declaration=True, encoding="UTF-8", pretty_print=True)
print()
print("scritto:", DST)
print("dinamiche inserite:", len(added))

assert len(added) == len(MARKINGS), "non tutte le marcature sono state inserite"