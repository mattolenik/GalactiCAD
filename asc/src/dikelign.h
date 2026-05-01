//
// dikelign.h
//
// Header of dikelign.cc
//
// Tien-Tsin Wong 1996
// 
#ifndef __DIKELIGN_H
#define __DIKELIGN_H

#include "asc.h"
#include "misc.h"
#include "datatype.h"

// constants for status of crossing of the dike:
// simple, complex, going up or down.
#define CLEAR   0
#define GO_UP   1
#define GO_DOWN 2
#define COMPLEX 3

// inline table lookup functions
extern int G_LevelTable[DSIZE];
extern int G_LengthTable[DSIZE];
extern int G_NextDikeTable[DSIZE];
extern int G_StartTable[DSIZE];
extern int G_EndTable[DSIZE];

inline int Level(int i)
{
#ifdef DEBUG
  if (i>=DSIZE)
    ERREXIT("[Level]: Tablelookup out of bound %d\n");
#endif
  return G_LevelTable[i];
}

inline int Length(int i)
{
#ifdef DEBUG
  if (i>=SIZE)
    ERREXIT("[Length]: Tablelookup out of bound\n");
#endif
  return G_LengthTable[i];
}

inline int NextDike(int i)
{
#ifdef DEBUG
  if (i>=SIZE)
    ERREXIT("[NextDike]: Tablelookup out of bound\n");
#endif
  return G_NextDikeTable[i];
}

inline int Start(int i)
{
#ifdef DEBUG
  if (i>=SIZE)
    ERREXIT("[Start]: Tablelookup out of bound\n");
#endif
  return G_StartTable[i];
}

inline int End(int i)
{
#ifdef DEBUG
  if (i>=SIZE)
    ERREXIT("[End]: Tablelookup out of bound\n");
#endif
  return G_EndTable[i];
}


class Lign
{
  public:
    CHAR *occ;
    SIMPLEDT *ver;
    SIMPLEDT simple[SIZE];
    static SIMPLEDT *nullsimple;  // a well initialized null simple array for fast init of other simple[]
    static int simplesize;

  protected:
    void InitSimple();
    int SimpleQ(int myid, int inherent);

  public:
    Lign(){occ=NULL; ver=NULL;};
    ~Lign(){};
    void Init(CHAR *inocc, SIMPLEDT *inver);
    int NextSimple(int i) {return simple[NextDike(i)];};
    void PropagateUpSimple();
    void PropagateDownSimple();
    void MaxSimple(Lign *neighbor);
    void FillSimpleVacancy();
    void FillSpecSimpleVacancy();  // specially coded simple[]

  friend class Strip;
  friend class Padi;
  friend void LignNullSimpleInit();
};


void MinDikeSet(int minidx, int maxidx, int *ydike, int &ydikecnt);
void BreakDikeSet(int *ydike, int &ydikecnt, Lign *ylign, int i);
void DikeTableInit();
void LignNullSimpleInit();  // init the static nullsimple in class lign


#endif

