//
// strip.h
//
// Header of strip.cc
//
// Tien-Tsin Wong 1996
//
#ifndef __STRIP_H
#define __STRIP_H

#define COMPLETEUSED 1
#define PARTIALUSED 2
#define NOTUSED     3


// Although Strip inherent Lign, it does not call Lign::Init(), since
// Strip make use of the data of Lign in another way.
// The only reason to inherent is to inherent some functions and the
// data.
class Strip
{
  public:
    SIMPLEDT simple[SIZE];
    Padi *usedby[SIZE];

  public:
    Strip(){};
    ~Strip(){};
    void Init(Lign *lign1, Lign *lign2);
    int NextSimple(int i) {return simple[NextDike(i)];};
    int UsedBy(int dike, Padi **occup, int &cnt);
};


void ShowTagMap(Strip *xstrip);

#endif

