"""
Pydantic response models for the BiNgo Genome Viewer API.

Defines schemas for genomes, tracks, coverage bins, read alignments,
variants, and annotation features returned by the data endpoints.
"""

from pydantic import BaseModel
from typing import Optional, List


class Chromosome(BaseModel):
    name: str
    length: int


class GenomeInfo(BaseModel):
    name: str
    chromosomes: List[Chromosome]


class SequenceResponse(BaseModel):
    chrom: str
    start: int
    end: int
    sequence: str


class TrackInfo(BaseModel):
    id: str
    name: str
    file_path: str
    track_type: str  # coverage, reads, variants, annotations
    file_format: str  # bam, cram, vcf, bigwig, bedgraph, wig, bed, gtf, gff, genbank


class CoverageBin(BaseModel):
    start: int
    end: int
    value: float


class CoverageResponse(BaseModel):
    chrom: str
    start: int
    end: int
    bins: List[CoverageBin]
    max_value: float


class ReadAlignment(BaseModel):
    start: int
    end: int
    strand: str  # "+" or "-"
    name: str
    mapq: int
    cigar: str
    sequence: Optional[str] = None
    row: int = 0  # pileup row for non-overlapping layout


class ReadsResponse(BaseModel):
    chrom: str
    start: int
    end: int
    reads: List[ReadAlignment]
    total: int


class Variant(BaseModel):
    chrom: str
    pos: int
    ref: str
    alt: List[str]
    qual: Optional[float] = None
    filter: Optional[str] = None
    info: Optional[dict] = None


class VariantsResponse(BaseModel):
    chrom: str
    start: int
    end: int
    variants: List[Variant]


class Feature(BaseModel):
    start: int
    end: int
    strand: str  # "+", "-", or "."
    name: str
    feature_type: str  # gene, CDS, mRNA, exon, etc.
    attributes: dict = {}
    sub_features: List["Feature"] = []


Feature.model_rebuild()


class FeaturesResponse(BaseModel):
    chrom: str
    start: int
    end: int
    features: List[Feature]
