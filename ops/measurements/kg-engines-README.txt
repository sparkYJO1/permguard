Three independent runs of `pnpm run bench:kg`, same machine, same data
generator, nothing changed between them.

They are all committed because one run of this benchmark is not a result. Cell
to cell the numbers move by a factor of two, and the first run — the one the
original write-up quoted — showed Neo4j winning Q1 and Q3 at the largest shape,
which the next two did not reproduce.

What reproduces across all three, at the `large` shape (180 users, 25,001
grants):

  Q2 why     neo4j 0.82-1.56   pg-kg 3.26-3.44    Neo4j wins, 2-4x
  Q4 blast   neo4j 32.2-34.0   pg-kg 81.0-92.6    Neo4j wins, ~2.5x
  Q3 who     neo4j 20.3-21.4   pg-kg 21.7-23.8    tie
  Q1 check   neo4j 0.95-2.29   pg-kg 1.90-2.09    noise; relational wins both

And the scaling, small -> large (a 50x larger graph):

  Q4 blast   pg-kg  2.5 ->  81-93 ms   (~30x)
             neo4j  2.9 ->  32-34 ms   (~6-11x)
  Q2 why     pg-kg  1.2 ->  3.3-3.4 ms (~2.6x)
             neo4j  1.3 ->  0.8-1.6 ms (flat or better)

The slope is the robust finding. Individual cells are not.
