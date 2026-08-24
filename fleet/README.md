# Fleet — Starfleet Complement

A complete, working fleet topology for [Fleet Graph](../README.md) built from
Teknium's [Hermes Star Trek profiles](https://github.com/teknium1/hermes-star-trek-profiles)
(68 installable personas across TOS, TNG, DS9, and Voyager), organized into a
four-rank command structure.

## What's here

- `fleet_graph.example.yaml` — the full 75-node topology. Drop it at
  `~/.hermes/fleet_graph.yaml` (or merge the parts you want).

## Department structure

| Division | Head | Complement |
|---|---|---|
| High Command | lilith + baal (peers in all but name) | sophia, lucifer |
| Staff / Core | hermes | default, thoth |
| Sciences | thoth | spock, data, jadzia-dax, seven-of-nine, chekov, wesley-crusher, naomi-wildman, icheb |
| Engineering | hermes | scotty, geordi-la-forge, belanna-torres, both O'Briens, barclay ×2, harry-kim, tom-paris, rom, sulu |
| Security / Nightwatch | nyx | worf ×2, tuvok, odo, tasha-yar |
| Medical & Counsel | default | mccoy, beverly-crusher, pulaski, bashir, the-doctor, chapel, kes, troi, ezri-dax, guinan, neelix, vic-fontaine, keiko |
| Command School advisors | sophia | picard, janeway, sisko, pike, riker, number-one, chakotay, martok, sarek, lwaxana-troi, jake-sisko, kira, damar, nog |
| Red Team (Illumination Directorate) | lucifer | lore, garak, q, mudd, khan, dukat, seska, borg-queen, ransom, weyoun, kai-winn, ro-laren |
| Legal & Ethics | yeshua | quark |

Peer bonds: lucifer ⋄ yeshua · spock ⋄ data · worf ⋄ tuvok

## Deploy it

```bash
# 1. Install the Starfleet profiles (one-time)
git clone https://github.com/teknium1/hermes-star-trek-profiles.git
cd hermes-star-trek-profiles && python3 manage.py install --all --alias --yes

# 2. Adopt this fleet
cp fleet/fleet_graph.example.yaml ~/.hermes/fleet_graph.yaml

# 3. Open the Fleet Graph desktop plugin and look at your ship
```

## Verified against

This exact topology runs live on its author's machine: 75 nodes, 4 ranks,
3 peer pairs, zero stale profiles under `maintenance/fleet-maint.py status`,
and graph walks at ~0.02 ms — well past the plugin's verified 26-node bound.
