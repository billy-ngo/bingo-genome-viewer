"""
Backend tests: run from the repository root with

    python -B -m unittest discover -s tests -v

They use synthetic BAM files (bam_synth.py) and the backend in app/backend.
"""

import asyncio
import io
import random
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "app" / "backend"
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import bam_synth  # noqa: E402
from readers import bam_coverage, bam_reader  # noqa: E402
from readers.bam_coverage import BamCoverageIndex  # noqa: E402
from readers.bam_reader import BamReader  # noqa: E402

REFS = [("chrA", 20_000), ("chrB", 7_000), ("chrC", 3_000)]


def _reads(seed=1, n=1500):
    """Sorted reads on REFS, with deletions, introns, soft clips, skipped
    flags, CG-tag CIGARs and reads running past a contig end."""
    rnd = random.Random(seed)
    out = []
    for ref, L in REFS[:2]:                       # chrC has no reads
        for i in range(n):
            pos = rnd.randrange(-50, L - 20) if i else 0
            pos = max(pos, 0)
            shape = rnd.random()
            if shape < 0.6:
                cigar = [(rnd.randint(30, 150), "M")]
            elif shape < 0.8:
                cigar = [(5, "S"), (40, "M"), (rnd.randint(1, 30), "D"), (40, "M")]
            elif shape < 0.9:
                cigar = [(30, "M"), (rnd.randint(100, 2000), "N"), (30, "="), (2, "X")]
            else:
                cigar = [(20, "M"), (3, "I"), (60, "M")]
            flag = rnd.choice([0, 0, 0, 16, 0x400, 0x200, 0x100, 0x800])
            out.append({"ref": ref, "pos": pos, "cigar": cigar, "flag": flag,
                        "name": f"{ref}_{i}", "cg": rnd.random() < 0.05})
    out.append({"ref": "chrB", "pos": 6_950, "cigar": [(200, "M")], "name": "past_end"})
    out.sort(key=lambda r: ([n for n, _ in REFS].index(r["ref"]), r["pos"]))
    return out


class _TempDir(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="bingo_test_"))

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def bam(self, reads, name="t.bam", **kw):
        path = str(self.dir / name)
        bam_synth.write_bam(path, REFS, reads, **kw)
        return path


class CoverageIndexTest(_TempDir):
    def check_exact(self, idx, reads):
        depth = bam_synth.expected_depth(REFS, reads)
        rnd = random.Random(3)
        for ref, L in REFS:
            for _ in range(25):
                a = rnd.randrange(0, L - 1)
                b = min(L + 100, a + rnd.choice([1, 17, 640, 5000, L]))
                n = rnd.choice([1, 3, 100, 1000])
                got, state = idx.coverage(ref, a, b, n)
                self.assertEqual(state, "ready")
                self.assertEqual(got, bam_synth.expected_bins(depth[ref], a, b, n), (ref, a, b, n))

    def test_builds_exactly_in_a_child_process(self):
        reads = _reads()
        idx = BamCoverageIndex(self.bam(reads))
        self.assertTrue(idx.wait(60))
        self.assertEqual(idx.status()["state"], "ready", idx.error)
        self.assertFalse(idx.in_process)          # not a thread of the server
        self.check_exact(idx, reads)

    def test_builds_in_a_thread_when_no_process_starts(self):
        reads = _reads(seed=2)
        real = bam_coverage._child_command
        bam_coverage._child_command = lambda path: (_ for _ in ()).throw(OSError("no processes here"))
        try:
            idx = BamCoverageIndex(self.bam(reads))
            self.assertTrue(idx.wait(60))
        finally:
            bam_coverage._child_command = real
        self.assertTrue(idx.in_process)
        self.assertEqual(idx.state, "ready", idx.error)
        self.check_exact(idx, reads)

    def test_a_process_that_says_nothing_is_replaced_by_a_thread(self):
        reads = _reads(seed=4)
        real = bam_coverage._child_command
        bam_coverage._child_command = lambda path: [sys.executable, "-c", "pass"]
        try:
            idx = BamCoverageIndex(self.bam(reads))
            self.assertTrue(idx.wait(60))
        finally:
            bam_coverage._child_command = real
        self.assertTrue(idx.in_process)
        self.assertEqual(idx.state, "ready", idx.error)
        self.check_exact(idx, reads)

    def test_unsorted_records_withdraw_partial_depth(self):
        reads = _reads(seed=5)
        shuffled = reads[:]
        random.Random(9).shuffle(shuffled)
        path = self.bam(shuffled)              # the header still claims SO:coordinate
        out = io.BytesIO()
        bam_coverage._build(path, out)
        kinds = []
        raw = out.getvalue()
        p = 0
        while p < len(raw):
            kind, ci, a, b = bam_coverage._MSG.unpack_from(raw, p)
            p += bam_coverage._MSG.size + {b"D": 4 * b, b"B": 16 * a, b"E": b}.get(kind, 0)
            kinds.append(kind)
        self.assertIn(b"W", kinds)
        self.assertEqual(kinds[-1], b"F")
        idx = BamCoverageIndex(path)
        self.assertTrue(idx.wait(60))
        self.assertEqual(idx.state, "ready", idx.error)
        self.check_exact(idx, shuffled)

    def test_partial_depth_is_exact_where_final(self):
        reads = _reads(seed=6, n=4000)
        path = self.bam(reads)
        out = io.BytesIO()
        real = bam_coverage._CHUNK
        bam_coverage._CHUNK = 1 << 12           # many chunks: many partial sends
        try:
            bam_coverage._build(path, out)
        finally:
            bam_coverage._CHUNK = real
        idx = BamCoverageIndex(path, start=False)
        out.seek(0)
        depth = bam_synth.expected_depth(REFS, reads)
        seen_partial = False
        size = bam_coverage._MSG.size
        while True:                             # one message at a time, looking after each
            pos = out.tell()
            head = out.read(size)
            if not head:
                break
            kind, ci, a, b = bam_coverage._MSG.unpack(head)
            body = {b"D": 4 * b, b"B": 16 * a, b"E": b}.get(kind, 0)
            out.seek(pos)
            try:
                idx._apply_messages(io.BytesIO(out.read(size + body)), False)
            except EOFError:
                pass                            # the message was applied; F is still to come
            if idx.state == "building":
                name = REFS[0][0]
                upto = idx._final_upto[name]
                if 0 < upto < REFS[0][1]:
                    seen_partial = True
                    got, state = idx.coverage(name, 0, upto, 50)
                    self.assertEqual(state, "building")
                    self.assertFalse(any(x.get("pending") for x in got))
                    self.assertEqual(got, bam_synth.expected_bins(depth[name], 0, upto, 50))
        self.assertTrue(seen_partial)
        self.assertEqual(idx.state, "ready")
        self.check_exact(idx, reads)

    def test_a_cut_off_bam_fails_the_build_and_is_reported(self):
        reads = _reads(seed=7)
        path = self.bam(reads, truncate_at=20_000)
        r = BamReader(path)
        try:
            self.assertTrue(r._cov.wait(60))
            self.assertEqual(r._cov.state, "failed")
            self.assertIn("EOFError", r._cov.error)
            # The live pileup takes over, and finds the cut too: an error, never
            # coverage that silently stops.
            with self.assertRaisesRegex(RuntimeError, "corrupt or truncated"):
                r.get_coverage("chrA", 0, 20_000, 10)
            self.assertEqual(len(r.get_coverage("chrC", 0, 3_000, 10)["bins"]), 10)   # no reads there
        finally:
            r.close()

    def test_cancel_stops_the_build_process(self):
        reads = _reads(seed=8, n=6000)
        idx = BamCoverageIndex(self.bam(reads))
        proc = idx._proc
        idx.cancel()
        self.assertTrue(idx.wait(30))
        self.assertIn(idx.state, ("cancelled", "ready"))   # ready: it was quicker than the cancel
        if proc is not None:
            self.assertIsNotNone(proc.poll())


class LiveCoverageTest(_TempDir):
    def test_live_pileup_is_exact(self):
        reads = _reads(seed=11)
        reads.append({"ref": "chrA", "pos": 100, "cigar": [(50, "M"), (15_000, "D"), (50, "M")], "name": "long_del"})
        reads.sort(key=lambda r: ([n for n, _ in REFS].index(r["ref"]), r["pos"]))
        r = BamReader(self.bam(reads))
        try:
            r._cov.cancel()
            depth = bam_synth.expected_depth(REFS, reads)
            rnd = random.Random(12)
            for ref, L in REFS:
                for _ in range(20):
                    a = rnd.randrange(0, L - 1)
                    b = min(L + 50, a + rnd.choice([1, 300, 4000, L]))
                    n = rnd.choice([1, 9, 200])
                    got, truncated = r._live_coverage(ref, a, b, n)
                    self.assertFalse(truncated)
                    self.assertEqual(got, bam_synth.expected_bins(depth[ref], a, b, n), (ref, a, b, n))
            # The read cap: the rest is pending, never zero.
            real = bam_reader.MAX_COVERAGE_READS
            bam_reader.MAX_COVERAGE_READS = 200
            try:
                got, truncated = r._live_coverage("chrA", 0, 20_000, 100)
            finally:
                bam_reader.MAX_COVERAGE_READS = real
            self.assertTrue(truncated)
            pending = [b for b in got if b.get("pending")]
            self.assertTrue(pending and pending[-1]["end"] == 20_000)
            done = [b for b in got if not b.get("pending")]
            self.assertEqual(done, bam_synth.expected_bins(depth["chrA"], 0, 20_000, 100)[:len(done)])
            got, truncated = r._live_coverage("nope", 0, 100, 5)     # not in this BAM: no data
            self.assertFalse(truncated or any(b["cov"] for b in got))
        finally:
            r.close()


class ChromNameTest(_TempDir):
    def setUp(self):
        super().setUp()
        import state
        self.state_mod = state
        self.app_state = state.AppState()

    def test_bam_version_rule_needs_a_unique_genome_name(self):
        refs = [("k141_9.0", 3_000)]
        reads = [{"ref": "k141_9.0", "pos": p, "cigar": [(100, "M")], "name": f"r{p}"} for p in range(0, 2_800, 40)]
        bam = str(self.dir / "k.bam")
        bam_synth.write_bam(bam, refs, reads)
        fa = self.dir / "g.fa"
        fa.write_text("".join(f">k141_9.{i}\n{'ACGT' * (750 + i)}\n" for i in range(3)))
        s = self.app_state
        s.load_genome(str(fa))
        info = s.load_track(bam, "k.bam")
        tid = info["id"]
        try:
            self.assertEqual(s.resolve_track_chrom(tid, "k141_9.0"), "k141_9.0")
            self.assertIsNone(s.resolve_track_chrom(tid, "k141_9.1"))
            self.assertIsNone(s.resolve_track_chrom(tid, "k141_9.2"))
            # Through the API: no reads and no coverage on the unpaired contigs.
            from fastapi.testclient import TestClient
            import api.data as data
            real = data.app_state
            data.app_state = s
            try:
                from fastapi import FastAPI
                app = FastAPI()
                app.include_router(data.router)
                c = TestClient(app)
                s.readers[tid]._cov.wait(30)
                got = c.get(f"/api/tracks/{tid}/reads", params={"chrom": "k141_9.1", "start": 0, "end": 3000}).json()
                self.assertEqual((got["reads"], got["total"]), ([], 0))
                got = c.get(f"/api/tracks/{tid}/reads", params={"chrom": "k141_9.0", "start": 0, "end": 3000}).json()
                self.assertEqual(got["total"], len(reads))
                got = c.get(f"/api/tracks/{tid}/coverage", params={"chrom": "k141_9.2", "start": 0, "end": 3000, "bins": 10}).json()
                self.assertEqual(got["bins"], [])
                got = c.get(f"/api/tracks/{tid}/stats", params={"chrom": "k141_9.1", "start": 0, "end": 3000}).json()
                self.assertEqual(got["covered_bp"], 0)
                got = c.get(f"/api/tracks/{tid}/coverage", params={"chrom": "k141_9.0", "start": 0, "end": 3000, "bins": 10}).json()
                self.assertGreater(got["peak_max"], 0)
            finally:
                data.app_state = real
        finally:
            s.remove_track(tid)

    def test_non_bam_readers_still_resolve_names_themselves(self):
        wig = self.dir / "one.wig"
        wig.write_text("variableStep chrom=contig_x\n1 5\n2 6\n")
        fa = self.dir / "g.fa"
        fa.write_text(">LOCUS\n" + "ACGT" * 10 + "\n")
        s = self.app_state
        s.load_genome(str(fa))
        tid = s.load_track(str(wig), "one.wig")["id"]
        self.assertEqual(s.resolve_track_chrom(tid, "LOCUS"), "LOCUS")


class AddChromosomesTest(_TempDir):
    def test_parse_runs_off_the_event_loop_and_outside_the_genome_lock(self):
        import api.genome as genome_api
        from readers.genome_reader import GenomeReader
        import state
        s = state.AppState()
        main_fa = self.dir / "main.fa"
        main_fa.write_text(">chr1\n" + "ACGT" * 50 + "\n")
        s.load_genome(str(main_fa))
        seen = {}
        real_open = GenomeReader.open_file.__func__

        def spy(cls, path):
            try:
                asyncio.get_running_loop()
                seen["loop"] = True
            except RuntimeError:
                seen["loop"] = False
            free = s.genome_lock.acquire(blocking=False)
            if free:
                s.genome_lock.release()
            seen["lock_free"] = free
            return real_open(cls, path)

        real_state = genome_api.app_state
        GenomeReader.open_file = classmethod(spy)
        genome_api.app_state = s
        try:
            from fastapi import FastAPI
            from fastapi.testclient import TestClient
            app = FastAPI()
            app.include_router(genome_api.router)
            c = TestClient(app)
            plasmid = self.dir / "plasmid.fa"
            plasmid.write_text(">p1\n" + "GGCC" * 20 + "\n")
            with plasmid.open("rb") as fh:
                res = c.post("/api/genome/add-chromosomes", files={"file": ("plasmid.fa", fh)})
            self.assertEqual(res.status_code, 200, res.text)
            self.assertEqual([x["name"] for x in res.json()["chromosomes"]], ["chr1", "p1"])
            self.assertEqual(seen, {"loop": False, "lock_free": True})
            # The same file again adds nothing and is refused.
            with plasmid.open("rb") as fh:
                res = c.post("/api/genome/add-chromosomes", files={"file": ("plasmid.fa", fh)})
            self.assertEqual(res.status_code, 400)
            self.assertIn("No new chromosomes", res.json()["detail"])
        finally:
            GenomeReader.open_file = classmethod(real_open)
            genome_api.app_state = real_state

    def test_a_merge_into_a_replaced_genome_is_refused(self):
        import state
        s = state.AppState()
        a = self.dir / "a.fa"
        a.write_text(">a\nACGT\n")
        b = self.dir / "b.fa"
        b.write_text(">b\nACGT\n")
        s.load_genome(str(a))
        old = s.genome
        opened = s.open_genome_file(str(b))
        s.load_genome(str(a))                      # replaced meanwhile
        with self.assertRaises(ValueError):
            s.add_chromosomes(str(b), opened, old)
        self.assertEqual([c["name"] for c in s.genome.chromosomes], ["a"])


class DevBundleTest(_TempDir):
    def test_an_older_build_than_the_sources_is_stale(self):
        import main
        dist = self.dir / "frontend" / "dist"
        src = self.dir / "frontend" / "src"
        dist.mkdir(parents=True)
        src.mkdir()
        (src / "App.jsx").write_text("x")
        time.sleep(0.05)
        (dist / "index.html").write_text("<html>")
        self.assertFalse(main._stale_bundle(dist))
        time.sleep(0.05)
        (src / "App.jsx").write_text("y")
        self.assertTrue(main._stale_bundle(dist))
        shutil.rmtree(src)                          # the Docker image: no sources beside it
        self.assertFalse(main._stale_bundle(dist))


class MirrorTest(unittest.TestCase):
    def test_server_tree_is_a_byte_identical_copy(self):
        server = ROOT / "bingoviewer" / "server"
        for f in BACKEND.rglob("*.py"):
            if "__pycache__" in f.parts:
                continue
            twin = server / f.relative_to(BACKEND)
            self.assertTrue(twin.exists(), twin)
            self.assertEqual(f.read_bytes(), twin.read_bytes(), str(f.relative_to(BACKEND)))


if __name__ == "__main__":
    unittest.main()
